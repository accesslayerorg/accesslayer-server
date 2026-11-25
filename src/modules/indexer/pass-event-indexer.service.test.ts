const store = {
   events: new Map<string, any>(),
   redemptions: new Map<string, any>(),
};

const prismaMock: any = {
   passEvent: {
      upsert: jest.fn(async ({ where, create }: any) => {
         if (!store.events.has(where.id)) {
            store.events.set(where.id, { redeemedCount: 0, ...create });
         }
         return store.events.get(where.id);
      }),
      findUnique: jest.fn(async ({ where }: any) => {
         return store.events.get(where.id) ?? null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
         const row = store.events.get(where.id)!;
         const next = { ...row };
         for (const [k, v] of Object.entries(data)) {
            next[k] =
               v && typeof v === 'object' && 'increment' in (v as any)
                  ? row[k] + (v as any).increment
                  : v;
         }
         store.events.set(where.id, next);
         return next;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
         const row = store.events.get(where.id);
         if (row && row.closed === where.closed) {
            store.events.set(where.id, { ...row, ...data });
            return { count: 1 };
         }
         return { count: 0 };
      }),
   },
   passRedemption: {
      findUnique: jest.fn(async ({ where }: any) => {
         if (where.txHash_eventIndex) {
            for (const row of store.redemptions.values()) {
               if (
                  row.txHash === where.txHash_eventIndex.txHash &&
                  row.eventIndex === where.txHash_eventIndex.eventIndex
               ) {
                  return { ...row };
               }
            }
            return null;
         }
         if (where.eventId_wallet) {
            const key = `${where.eventId_wallet.eventId}:${where.eventId_wallet.wallet}`;
            return store.redemptions.get(key) ?? null;
         }
         return null;
      }),
      create: jest.fn(async ({ data }: any) => {
         const row = { id: `pr_${store.redemptions.size + 1}`, ...data };
         store.redemptions.set(`${data.eventId}:${data.wallet}`, row);
         return row;
      }),
   },
   $transaction: jest.fn(async (fn: any) => fn(prismaMock)),
};

jest.mock('../../utils/prisma.utils', () => ({ prisma: prismaMock }));
jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { PASS_EVENT_TYPES, processPassEvents } from './pass-event-indexer.service';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

const created = (overrides: Partial<IndexerChainEvent> = {}): IndexerChainEvent => ({
   eventType: 'event_created',
   txHash: 'tx-create-1',
   eventIndex: 0,
   ledger: 100,
   eventId: 'evt-1',
   keyId: 'key-1',
   creatorWallet: 'GCREATOR',
   title: 'VIP Meetup',
   startLedger: 110,
   endLedger: 200,
   capacity: 2,
   minBalance: '5',
   ...overrides,
});

const redeemed = (overrides: Partial<IndexerChainEvent> = {}): IndexerChainEvent => ({
   eventType: 'redeemed',
   txHash: 'tx-redeem-1',
   eventIndex: 0,
   ledger: 120,
   eventId: 'evt-1',
   wallet: 'GHOLDER1',
   ...overrides,
});

const closed = (overrides: Partial<IndexerChainEvent> = {}): IndexerChainEvent => ({
   eventType: 'event_closed',
   txHash: 'tx-close-1',
   eventIndex: 0,
   ledger: 150,
   eventId: 'evt-1',
   ...overrides,
});

describe('PassEventIndexer (#1332)', () => {
   beforeEach(() => {
      store.events.clear();
      store.redemptions.clear();
      jest.clearAllMocks();
   });

   it('registers event_created, redeemed, and event_closed', () => {
      expect(PASS_EVENT_TYPES.has('event_created')).toBe(true);
      expect(PASS_EVENT_TYPES.has('redeemed')).toBe(true);
      expect(PASS_EVENT_TYPES.has('event_closed')).toBe(true);
   });

   it('updates capacity, redeemedCount, and closed state from indexed events', async () => {
      await processPassEvents([
         created(),
         redeemed(),
         redeemed({ txHash: 'tx-redeem-2', wallet: 'GHOLDER2', ledger: 125 }),
         closed(),
      ]);

      const evt = store.events.get('evt-1');
      expect(evt.capacity).toBe(2);
      expect(evt.redeemedCount).toBe(2);
      expect(evt.closed).toBe(true);
   });

   it('does not double count redemptions when events are replayed', async () => {
      const batch = [created(), redeemed()];
      await processPassEvents(batch);
      await processPassEvents(batch);

      const evt = store.events.get('evt-1');
      expect(evt.redeemedCount).toBe(1);
      expect(store.redemptions.size).toBe(1);
   });
});
