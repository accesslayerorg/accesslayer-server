import { SorobanWALService } from './soroban-wal.service';
import {
   ApplySorobanSideEffects,
   CreateSorobanWALEntry,
   RollbackSorobanOptimisticState,
   SorobanTransactionGateway,
   SorobanTransactionStatus,
   SorobanWALEntry,
   SorobanWALStore,
   ValidateSorobanOperation,
} from './soroban-wal.types';

const input: CreateSorobanWALEntry = {
   idempotencyKey: 'trade-1',
   operation: 'BUY',
   wallet: 'GBUYER',
   creatorWallet: 'GCREATOR',
   amount: '2',
   expectedSupplyBefore: '10',
   xdrPayload: 'AAAA',
};

class MemoryWALStore implements SorobanWALStore {
   readonly entries = new Map<string, SorobanWALEntry>();
   private sequence = 0;

   async createPending(
      createInput: CreateSorobanWALEntry,
      validate: ValidateSorobanOperation
   ): Promise<{ entry: SorobanWALEntry; created: boolean }> {
      const existing = [...this.entries.values()].find(
         entry => entry.idempotencyKey === createInput.idempotencyKey
      );
      if (existing) return { entry: existing, created: false };

      await validate({});
      const now = new Date();
      const entry: SorobanWALEntry = {
         ...createInput,
         id: `wal-${++this.sequence}`,
         state: 'PENDING',
         txHash: null,
         submittedAt: null,
         confirmedAt: null,
         error: null,
         createdAt: now,
         updatedAt: now,
      };
      this.entries.set(entry.id, entry);
      return { entry, created: true };
   }

   async markSubmitted(id: string, txHash: string): Promise<SorobanWALEntry> {
      return this.update(id, {
         state: 'SUBMITTED',
         txHash,
         submittedAt: new Date(),
      });
   }

   async markFailed(
      id: string,
      error: string,
      rollback: RollbackSorobanOptimisticState
   ): Promise<SorobanWALEntry> {
      const entry = this.get(id);
      if (isTerminal(entry)) return entry;
      await rollback({}, entry);
      return this.update(id, { state: 'FAILED', error });
   }

   async markRolledBack(
      id: string,
      rollback: RollbackSorobanOptimisticState
   ): Promise<SorobanWALEntry> {
      const entry = this.get(id);
      if (isTerminal(entry)) return entry;
      await rollback({}, entry);
      return this.update(id, { state: 'ROLLED_BACK' });
   }

   async confirmAtomically(
      id: string,
      txHash: string,
      applySideEffects: ApplySorobanSideEffects
   ): Promise<SorobanWALEntry> {
      const entry = this.get(id);
      if (entry.state === 'CONFIRMED') return entry;
      if (entry.state !== 'SUBMITTED' || entry.txHash !== txHash) {
         throw new Error('invalid confirmation transition');
      }
      await applySideEffects({}, entry);
      return this.update(id, {
         state: 'CONFIRMED',
         confirmedAt: new Date(),
      });
   }

   async listRecoverable(olderThan: Date): Promise<SorobanWALEntry[]> {
      return [...this.entries.values()].filter(
         entry =>
            (entry.state === 'PENDING' || entry.state === 'SUBMITTED') &&
            entry.createdAt < olderThan
      );
   }

   private get(id: string): SorobanWALEntry {
      const entry = this.entries.get(id);
      if (!entry) throw new Error('missing WAL entry');
      return entry;
   }

   private update(
      id: string,
      change: Partial<SorobanWALEntry>
   ): SorobanWALEntry {
      const entry = { ...this.get(id), ...change, updatedAt: new Date() };
      this.entries.set(id, entry);
      return entry;
   }
}

function isTerminal(entry: SorobanWALEntry): boolean {
   return ['CONFIRMED', 'FAILED', 'ROLLED_BACK'].includes(entry.state);
}

function createGateway(
   statuses: SorobanTransactionStatus[] = [{ status: 'CONFIRMED' }]
): SorobanTransactionGateway & {
   submit: jest.Mock;
   getStatus: jest.Mock;
} {
   return {
      submit: jest.fn().mockResolvedValue({ txHash: 'tx-1' }),
      getStatus: jest.fn(
         async (): Promise<SorobanTransactionStatus> =>
            statuses.shift() ?? { status: 'PENDING' }
      ),
   };
}

function createService(
   store: SorobanWALStore,
   gateway: SorobanTransactionGateway
): SorobanWALService {
   return new SorobanWALService(store, gateway, {
      maxConfirmationAttempts: 3,
      baseRetryDelayMs: 1,
      sleep: async () => {},
   });
}

describe('SorobanWALService', () => {
   it('writes PENDING after validation and before chain submission', async () => {
      const order: string[] = [];
      const store = new MemoryWALStore();
      const gateway = createGateway();
      gateway.submit.mockImplementation(async () => {
         order.push('submit');
         expect([...store.entries.values()][0].state).toBe('PENDING');
         return { txHash: 'tx-1' };
      });

      await createService(store, gateway).execute({
         ...input,
         validate: async () => void order.push('validate'),
         applySideEffects: async () => {},
      });

      expect(order).toEqual(['validate', 'submit']);
   });

   it('rolls back stale PENDING entries without applying side effects', async () => {
      const store = new MemoryWALStore();
      await store.createPending(input, async () => {});
      const apply = jest.fn();
      const rollback = jest.fn();

      const recovered = await createService(store, createGateway()).recover(
         new Date(Date.now() + 31_000),
         apply,
         rollback
      );

      expect(recovered[0].state).toBe('ROLLED_BACK');
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(apply).not.toHaveBeenCalled();
   });

   it('recovers SUBMITTED entries and applies side effects exactly once', async () => {
      const store = new MemoryWALStore();
      const { entry } = await store.createPending(input, async () => {});
      await store.markSubmitted(entry.id, 'tx-1');
      const apply = jest.fn();
      const service = createService(store, createGateway());
      const cutoff = new Date(Date.now() + 31_000);

      await service.recover(cutoff, apply);
      await service.recover(cutoff, apply);

      expect(apply).toHaveBeenCalledTimes(1);
      expect(store.entries.get(entry.id)?.state).toBe('CONFIRMED');
   });

   it('deduplicates retries by idempotency key', async () => {
      const store = new MemoryWALStore();
      const gateway = createGateway();
      const service = createService(store, gateway);
      const apply = jest.fn();

      await service.execute({ ...input, applySideEffects: apply });
      await service.execute({ ...input, applySideEffects: apply });

      expect(store.entries.size).toBe(1);
      expect(gateway.submit).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledTimes(1);
   });

   it('produces the same state after recovery as a crash-free execution', async () => {
      const crashFreeStore = new MemoryWALStore();
      let crashFreeBalance = 0;
      await createService(crashFreeStore, createGateway()).execute({
         ...input,
         applySideEffects: async () => {
            crashFreeBalance += Number(input.amount);
         },
      });

      const recoveredStore = new MemoryWALStore();
      const { entry } = await recoveredStore.createPending(
         input,
         async () => {}
      );
      await recoveredStore.markSubmitted(entry.id, 'tx-1');
      let recoveredBalance = 0;
      await createService(recoveredStore, createGateway()).recover(
         new Date(Date.now() + 31_000),
         async () => {
            recoveredBalance += Number(input.amount);
         }
      );

      expect(recoveredBalance).toBe(crashFreeBalance);
      expect(recoveredStore.entries.get(entry.id)?.state).toBe('CONFIRMED');
   });
});
