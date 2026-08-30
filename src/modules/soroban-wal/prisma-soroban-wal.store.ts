import { prisma } from '../../utils/prisma.utils';
import {
   ApplySorobanSideEffects,
   CreateSorobanWALEntry,
   RollbackSorobanOptimisticState,
   SorobanWALEntry,
   SorobanWALStore,
   ValidateSorobanOperation,
} from './soroban-wal.types';

type RawEntry = Omit<SorobanWALEntry, 'amount' | 'expectedSupplyBefore'> & {
   amount: { toString(): string } | string | number;
   expectedSupplyBefore: { toString(): string } | string | number;
};

interface WalDelegate {
   findUnique(args: unknown): Promise<RawEntry | null>;
   findMany(args: unknown): Promise<RawEntry[]>;
   create(args: unknown): Promise<RawEntry>;
   update(args: unknown): Promise<RawEntry>;
}

export interface SorobanWALDatabaseTransaction {
   sorobanWALEntry: WalDelegate;
   $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
   [model: string]: unknown;
}

interface WalClient extends SorobanWALDatabaseTransaction {
   $transaction<T>(
      operation: (transaction: SorobanWALDatabaseTransaction) => Promise<T>,
      options?: { isolationLevel: 'Serializable' }
   ): Promise<T>;
}

const client = prisma as unknown as WalClient;

export class PrismaSorobanWALStore implements SorobanWALStore {
   async createPending(
      input: CreateSorobanWALEntry,
      validate: ValidateSorobanOperation
   ): Promise<{ entry: SorobanWALEntry; created: boolean }> {
      try {
         return await client.$transaction(
            async transaction => {
               const existing = await transaction.sorobanWALEntry.findUnique({
                  where: { idempotencyKey: input.idempotencyKey },
               });
               if (existing) {
                  return { entry: normalizeEntry(existing), created: false };
               }

               await validate(transaction);
               const entry = await transaction.sorobanWALEntry.create({
                  data: { ...input, state: 'PENDING' },
               });
               return { entry: normalizeEntry(entry), created: true };
            },
            { isolationLevel: 'Serializable' }
         );
      } catch (error) {
         if (!isUniqueConstraintError(error)) throw error;

         const existing = await client.sorobanWALEntry.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
         });
         if (!existing) throw error;
         return { entry: normalizeEntry(existing), created: false };
      }
   }

   async markSubmitted(id: string, txHash: string): Promise<SorobanWALEntry> {
      return client.$transaction(
         async transaction => {
            const entry = await lockEntry(transaction, id);
            if (entry.state !== 'PENDING') {
               throw new Error(
                  `Cannot submit WAL entry ${id} from state ${entry.state}`
               );
            }
            return normalizeEntry(
               await transaction.sorobanWALEntry.update({
                  where: { id },
                  data: {
                     state: 'SUBMITTED',
                     txHash,
                     submittedAt: new Date(),
                     error: null,
                  },
               })
            );
         },
         { isolationLevel: 'Serializable' }
      );
   }

   async markFailed(
      id: string,
      error: string,
      rollback: RollbackSorobanOptimisticState
   ): Promise<SorobanWALEntry> {
      return this.finishWithRollback(id, 'FAILED', error, rollback);
   }

   async markRolledBack(
      id: string,
      rollback: RollbackSorobanOptimisticState
   ): Promise<SorobanWALEntry> {
      return this.finishWithRollback(id, 'ROLLED_BACK', null, rollback);
   }

   async confirmAtomically(
      id: string,
      txHash: string,
      applySideEffects: ApplySorobanSideEffects
   ): Promise<SorobanWALEntry> {
      return client.$transaction(
         async transaction => {
            const raw = await lockEntry(transaction, id);
            const entry = normalizeEntry(raw);

            if (entry.state === 'CONFIRMED') return entry;
            if (entry.state !== 'SUBMITTED' || entry.txHash !== txHash) {
               throw new Error(
                  `Cannot confirm WAL entry ${id} from state ${entry.state}`
               );
            }

            await applySideEffects(transaction, entry);

            return normalizeEntry(
               await transaction.sorobanWALEntry.update({
                  where: { id },
                  data: {
                     state: 'CONFIRMED',
                     confirmedAt: new Date(),
                     error: null,
                  },
               })
            );
         },
         { isolationLevel: 'Serializable' }
      );
   }

   async listRecoverable(olderThan: Date): Promise<SorobanWALEntry[]> {
      const entries = await client.sorobanWALEntry.findMany({
         where: {
            state: { in: ['PENDING', 'SUBMITTED'] },
            createdAt: { lt: olderThan },
         },
         orderBy: { createdAt: 'asc' },
      });
      return entries.map(normalizeEntry);
   }

   private async finishWithRollback(
      id: string,
      state: 'FAILED' | 'ROLLED_BACK',
      error: string | null,
      rollback: RollbackSorobanOptimisticState
   ): Promise<SorobanWALEntry> {
      return client.$transaction(
         async transaction => {
            const raw = await lockEntry(transaction, id);
            const entry = normalizeEntry(raw);
            if (
               entry.state === 'CONFIRMED' ||
               entry.state === 'FAILED' ||
               entry.state === 'ROLLED_BACK'
            ) {
               return entry;
            }

            await rollback(transaction, entry);
            return normalizeEntry(
               await transaction.sorobanWALEntry.update({
                  where: { id },
                  data: { state, error },
               })
            );
         },
         { isolationLevel: 'Serializable' }
      );
   }
}

async function lockEntry(
   transaction: SorobanWALDatabaseTransaction,
   id: string
): Promise<RawEntry> {
   await transaction.$queryRawUnsafe(
      'SELECT "id" FROM "soroban_wal_entries" WHERE "id" = $1 FOR UPDATE',
      id
   );
   const entry = await transaction.sorobanWALEntry.findUnique({
      where: { id },
   });
   if (!entry) throw new Error(`Soroban WAL entry ${id} was not found`);
   return entry;
}

function normalizeEntry(entry: RawEntry): SorobanWALEntry {
   return {
      ...entry,
      amount: entry.amount.toString(),
      expectedSupplyBefore: entry.expectedSupplyBefore.toString(),
   };
}

function isUniqueConstraintError(error: unknown): boolean {
   return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
   );
}
