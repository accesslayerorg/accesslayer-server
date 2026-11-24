type WindowRow = Record<string, any>;
type CommitRow = Record<string, any>;

const store = {
   windows: new Map<string, WindowRow>(),
   commits: new Map<string, CommitRow>(),
};

const prismaMock: any = {
   launchWindow: {
      upsert: jest.fn(async ({ where, create }: any) => {
         if (!store.windows.has(where.keyId)) {
            const row = {
               id: `lw_${store.windows.size + 1}`,
               commitCount: 0,
               revealCount: 0,
               clearingPrice: null,
               ...create,
            };
            store.windows.set(where.keyId, row);
         }
         return store.windows.get(where.keyId);
      }),
      findUnique: jest.fn(async ({ where }: any) => {
         return store.windows.get(where.keyId) ?? null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
         for (const [k, row] of store.windows.entries()) {
            if (row.id === where.id) {
               const next = { ...row };
               for (const [field, val] of Object.entries(data)) {
                  next[field] =
                     val && typeof val === 'object' && 'increment' in (val as any)
                        ? row[field] + (val as any).increment
                        : val;
               }
               store.windows.set(k, next);
               return next;
            }
         }
         return null;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
         let count = 0;
         for (const [k, row] of store.windows.entries()) {
            const phaseMatch =
               typeof where.phase === 'string'
                  ? row.phase === where.phase
                  : where.phase?.not
                    ? row.phase !== where.phase.not
                    : true;
            if (row.id === where.id && phaseMatch) {
               store.windows.set(k, { ...row, ...data });
               count += 1;
            }
         }
         return { count };
      }),
   },
   launchCommit: {
      findUnique: jest.fn(async ({ where }: any) => {
         if (where.commitTxHash_commitEventIndex) {
            const { commitTxHash, commitEventIndex } =
               where.commitTxHash_commitEventIndex;
            for (const row of store.commits.values()) {
               if (
                  row.commitTxHash === commitTxHash &&
                  row.commitEventIndex === commitEventIndex
               ) {
                  return { ...row };
               }
            }
            return null;
         }
         if (where.keyId_wallet) {
            const key = `${where.keyId_wallet.keyId}:${where.keyId_wallet.wallet}`;
            const row = store.commits.get(key);
            return row ? { ...row } : null;
         }
         return null;
      }),
      create: jest.fn(async ({ data }: any) => {
         const row = { id: `lc_${store.commits.size + 1}`, ...data };
         store.commits.set(`${data.keyId}:${data.wallet}`, row);
         return row;
      }),
      findMany: jest.fn(async ({ where }: any) => {
         return Array.from(store.commits.values()).filter(
            c =>
               c.launchWindowId === where.launchWindowId &&
               (where.revealed === undefined || c.revealed === where.revealed)
         );
      }),
      update: jest.fn(async ({ where, data }: any) => {
         for (const [k, row] of store.commits.entries()) {
            if (row.id === where.id) {
               const next = { ...row, ...data };
               store.commits.set(k, next);
               return next;
            }
         }
         return null;
      }),
   },
   $transaction: jest.fn(async (fn: any) => fn(prismaMock)),
};

jest.mock('../../utils/prisma.utils', () => ({ prisma: prismaMock }));
jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
   COMMIT_REVEAL_LAUNCH_EVENT_TYPES,
   processCommitRevealLaunchEvents,
} from './commit-reveal-launch-indexer.service';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

const commitEvent = (overrides: Partial<IndexerChainEvent> = {}): IndexerChainEvent => ({
   eventType: 'buy_committed',
   txHash: 'tx-commit-1',
   eventIndex: 0,
   ledger: 100,
   keyId: 'key-1',
   wallet: 'GWALLET1',
   commitment: '0xabc',
   commitEndLedger: 150,
   revealEndLedger: 200,
   ...overrides,
});

const revealEvent = (overrides: Partial<IndexerChainEvent> = {}): IndexerChainEvent => ({
   eventType: 'buy_revealed',
   txHash: 'tx-reveal-1',
   eventIndex: 0,
   ledger: 160,
   keyId: 'key-1',
   wallet: 'GWALLET1',
   amount: '10',
   maxPrice: '50',
   ...overrides,
});

const settledEvent = (overrides: Partial<IndexerChainEvent> = {}): IndexerChainEvent => ({
   eventType: 'launch_settled',
   txHash: 'tx-settle-1',
   eventIndex: 0,
   ledger: 205,
   keyId: 'key-1',
   clearingPrice: '40',
   ...overrides,
});

describe('CommitRevealLaunchIndexer (#1264)', () => {
   beforeEach(() => {
      store.windows.clear();
      store.commits.clear();
      jest.clearAllMocks();
   });

   it('registers buy_committed, buy_revealed, and launch_settled event types', () => {
      expect(COMMIT_REVEAL_LAUNCH_EVENT_TYPES.has('buy_committed')).toBe(true);
      expect(COMMIT_REVEAL_LAUNCH_EVENT_TYPES.has('buy_revealed')).toBe(true);
      expect(COMMIT_REVEAL_LAUNCH_EVENT_TYPES.has('launch_settled')).toBe(true);
   });

   it('indexes commit, reveal, and settled events and computes fills', async () => {
      await processCommitRevealLaunchEvents([
         commitEvent(),
         commitEvent({
            txHash: 'tx-commit-2',
            wallet: 'GWALLET2',
            commitment: '0xdef',
         }),
         revealEvent(),
         settledEvent(),
      ]);

      const win = store.windows.get('key-1')!;
      expect(win.phase).toBe('settled');
      expect(win.commitCount).toBe(2);
      expect(win.revealCount).toBe(1);
      expect(win.clearingPrice).toBe('40');

      const revealed = store.commits.get('key-1:GWALLET1')!;
      expect(revealed.revealed).toBe(true);
      expect(revealed.fillStatus).toBe('filled');
      expect(revealed.filledAmount).toBe('10');

      const unrevealed = store.commits.get('key-1:GWALLET2')!;
      expect(unrevealed.revealed).toBe(false);
      expect(unrevealed.fillStatus).toBe('pending');
   });

   it('is idempotent when replaying commit, reveal, or settled events', async () => {
      const batch = [commitEvent(), revealEvent(), settledEvent()];
      await processCommitRevealLaunchEvents(batch);
      await processCommitRevealLaunchEvents(batch);

      const win = store.windows.get('key-1')!;
      expect(win.commitCount).toBe(1);
      expect(win.revealCount).toBe(1);
      expect(store.commits.size).toBe(1);
   });
});
