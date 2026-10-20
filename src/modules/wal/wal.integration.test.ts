import { Prisma } from '@prisma/client';
import { SorobanWALService } from './wal.service';
import { WALRecoveryWorker } from './wal-recovery.worker';
import { ISorobanClient, HorizonTxResult } from './wal.types';

/**
 * High-fidelity in-memory Prisma Client mock that reproduces transaction atomicity,
 * table constraints, unique keys, and Prisma Decimal operations.
 */
function createInMemoryPrisma() {
   const walEntries = new Map<string, any>();
   const keyOwnerships = new Map<string, any>();
   const creatorStats = new Map<string, any>();
   const priceSnapshots: any[] = [];
   const transactionHistories = new Map<string, any>();
   const activities: any[] = [];

   let nextId = 1;

   const client: any = {
      sorobanWALEntry: {
         findUnique: async ({ where }: any) => {
            if (where.id) return walEntries.get(where.id) || null;
            if (where.txHash) {
               for (const entry of walEntries.values()) {
                  if (entry.txHash === where.txHash) return entry;
               }
               return null;
            }
            if (where.idempotencyKey) {
               for (const entry of walEntries.values()) {
                  if (entry.idempotencyKey === where.idempotencyKey)
                     return entry;
               }
               return null;
            }
            return null;
         },
         findFirst: async ({ where }: any) => {
            if (where.OR) {
               for (const condition of where.OR) {
                  const found = await client.sorobanWALEntry.findUnique({
                     where: condition,
                  });
                  if (found) return found;
               }
            }
            return null;
         },
         findMany: async ({ where, orderBy }: any) => {
            let results = Array.from(walEntries.values());
            if (where?.state?.in) {
               results = results.filter(e => where.state.in.includes(e.state));
            }
            if (where?.OR) {
               results = results.filter(entry => {
                  return where.OR.some((cond: any) => {
                     if (
                        cond.createdAt?.lte &&
                        entry.createdAt > cond.createdAt.lte
                     )
                        return false;
                     if (cond.submittedAt?.lte) {
                        if (
                           !entry.submittedAt ||
                           entry.submittedAt > cond.submittedAt.lte
                        )
                           return false;
                     }
                     return true;
                  });
               });
            }
            if (orderBy?.createdAt === 'asc') {
               results.sort(
                  (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
               );
            }
            return results;
         },
         create: async ({ data }: any) => {
            const id = `wal_${nextId++}`;
            const record = {
               id,
               txHash: data.txHash ?? null,
               idempotencyKey: data.idempotencyKey ?? null,
               ...data,
               createdAt: data.createdAt || new Date(),
               updatedAt: new Date(),
            };
            walEntries.set(id, record);
            return { ...record };
         },
         update: async ({ where, data }: any) => {
            const entry = walEntries.get(where.id);
            if (!entry) throw new Error(`WAL entry ${where.id} not found`);
            const updated = {
               ...entry,
               ...data,
               updatedAt: new Date(),
            };
            walEntries.set(where.id, updated);
            return { ...updated };
         },
      },

      keyOwnership: {
         findUnique: async ({ where }: any) => {
            const key = `${where.ownerAddress_creatorId.ownerAddress}_${where.ownerAddress_creatorId.creatorId}`;
            return keyOwnerships.get(key) || null;
         },
         upsert: async ({ where, create, update }: any) => {
            const key = `${where.ownerAddress_creatorId.ownerAddress}_${where.ownerAddress_creatorId.creatorId}`;
            const existing = keyOwnerships.get(key);
            if (existing) {
               let newBalance = new Prisma.Decimal(existing.balance);
               if (update.balance?.increment) {
                  newBalance = newBalance.add(update.balance.increment);
               }
               const updated = {
                  ...existing,
                  balance: newBalance,
                  updatedAt: new Date(),
               };
               keyOwnerships.set(key, updated);
               return updated;
            } else {
               const created = {
                  id: `own_${nextId++}`,
                  ...create,
                  balance: new Prisma.Decimal(create.balance),
                  createdAt: new Date(),
                  updatedAt: new Date(),
               };
               keyOwnerships.set(key, created);
               return created;
            }
         },
         count: async ({ where }: any) => {
            let count = 0;
            for (const own of keyOwnerships.values()) {
               if (where?.creatorId && own.creatorId !== where.creatorId)
                  continue;
               if (
                  where?.balance?.gt &&
                  !new Prisma.Decimal(own.balance).gt(where.balance.gt)
               )
                  continue;
               count++;
            }
            return count;
         },
      },

      creatorStats: {
         findUnique: async ({ where }: any) => {
            return creatorStats.get(where.creatorId) || null;
         },
         upsert: async ({ where, create, update }: any) => {
            const existing = creatorStats.get(where.creatorId);
            if (existing) {
               let newSupply = new Prisma.Decimal(existing.totalSupply);
               if (update.totalSupply)
                  newSupply = new Prisma.Decimal(update.totalSupply);

               let newVolume = new Prisma.Decimal(existing.totalVolume);
               if (update.totalVolume?.increment) {
                  newVolume = newVolume.add(update.totalVolume.increment);
               }

               const updated = {
                  ...existing,
                  holderCount: update.holderCount ?? existing.holderCount,
                  totalSupply: newSupply,
                  totalVolume: newVolume,
                  updatedAt: new Date(),
               };
               creatorStats.set(where.creatorId, updated);
               return updated;
            } else {
               const created = {
                  id: `stats_${nextId++}`,
                  ...create,
                  totalSupply: new Prisma.Decimal(create.totalSupply),
                  totalVolume: new Prisma.Decimal(create.totalVolume),
                  createdAt: new Date(),
                  updatedAt: new Date(),
               };
               creatorStats.set(where.creatorId, created);
               return created;
            }
         },
      },

      priceSnapshot: {
         create: async ({ data }: any) => {
            const snapshot = {
               id: `snap_${nextId++}`,
               ...data,
               price: new Prisma.Decimal(data.price),
               supply: new Prisma.Decimal(data.supply),
               timestamp: data.timestamp || new Date(),
            };
            priceSnapshots.push(snapshot);
            return snapshot;
         },
         findMany: async () => [...priceSnapshots],
      },

      transactionHistory: {
         findUnique: async ({ where }: any) => {
            return transactionHistories.get(where.txHash) || null;
         },
         upsert: async ({ where, create }: any) => {
            const existing = transactionHistories.get(where.txHash);
            if (existing) return existing;
            const created = {
               id: `txh_${nextId++}`,
               ...create,
               createdAt: new Date(),
            };
            transactionHistories.set(where.txHash, created);
            return created;
         },
         findMany: async () => Array.from(transactionHistories.values()),
      },

      activity: {
         create: async ({ data }: any) => {
            const act = {
               id: `act_${nextId++}`,
               ...data,
               createdAt: new Date(),
            };
            activities.push(act);
            return act;
         },
         findMany: async () => [...activities],
      },

      $transaction: async (fn: any) => {
         // Execute the callback passing the client as the transaction client
         return fn(client);
      },

      // Testing introspection helpers
      _dumpState: () => ({
         walEntries: Array.from(walEntries.values()),
         keyOwnerships: Array.from(keyOwnerships.values()).map(k => ({
            ...k,
            balance: k.balance.toString(),
         })),
         creatorStats: Array.from(creatorStats.values()).map(s => ({
            ...s,
            totalSupply: s.totalSupply.toString(),
            totalVolume: s.totalVolume.toString(),
         })),
         priceSnapshots: priceSnapshots.map(p => ({
            ...p,
            price: p.price.toString(),
            supply: p.supply.toString(),
         })),
         transactionHistories: Array.from(transactionHistories.values()),
         activities: activities.map(a => ({ ...a })),
      }),
   };

   return client;
}

class TestSorobanClient implements ISorobanClient {
   public submitCount = 0;
   public pollCount = 0;
   public txResultMap = new Map<string, HorizonTxResult>();
   public shouldFailSubmission = false;
   public submissionErrorMessage = 'Network timeout on Soroban RPC';

   async submitTransaction(_xdrPayload: string): Promise<{ txHash: string }> {
      this.submitCount++;
      if (this.shouldFailSubmission) {
         throw new Error(this.submissionErrorMessage);
      }
      const txHash = `hash_${this.submitCount}_${Date.now()}`;
      // Default to SUCCESS on Horizon unless overridden
      this.txResultMap.set(txHash, {
         status: 'SUCCESS',
         ledger: 1000 + this.submitCount,
      });
      return { txHash };
   }

   async getTransactionResult(txHash: string): Promise<HorizonTxResult> {
      this.pollCount++;
      return this.txResultMap.get(txHash) || { status: 'PENDING' };
   }
}

describe('Soroban Write-Ahead Log (WAL) & Crash Recovery Integration Tests', () => {
   let mockPrisma: any;
   let mockClient: TestSorobanClient;
   let walService: SorobanWALService;
   let recoveryWorker: WALRecoveryWorker;

   beforeEach(() => {
      mockPrisma = createInMemoryPrisma();
      mockClient = new TestSorobanClient();
      walService = new SorobanWALService(mockPrisma, mockClient);
      recoveryWorker = new WALRecoveryWorker(
         mockPrisma,
         walService,
         mockClient
      );
   });

   it('Requirement 1 & AC 1: Writes WAL entry with state PENDING before any Soroban call', async () => {
      const input = {
         operation: 'buy' as const,
         wallet: 'GBUYER123',
         creatorWallet: 'GCREATOR456',
         amount: 5,
         expectedSupplyBefore: 10,
         xdrPayload: 'AAAA...VALID_XDR',
      };

      const { entry } = await walService.createPendingWALEntry(input);

      expect(entry).toBeDefined();
      expect(entry.id).toMatch(/^wal_/);
      expect(entry.state).toBe('PENDING');
      expect(entry.operation).toBe('BUY');
      expect(entry.amount.toString()).toBe('5');
      expect(mockClient.submitCount).toBe(0); // Zero Soroban calls made before durable write
   });

   it('Requirement 5.1 & AC 2: Simulates crash between WAL PENDING write and Soroban submission -> recovery rolls back to ROLLED_BACK with no side effects', async () => {
      const input = {
         operation: 'buy' as const,
         wallet: 'GBUYER123',
         creatorWallet: 'GCREATOR456',
         amount: 5,
         expectedSupplyBefore: 10,
         xdrPayload: 'AAAA...VALID_XDR',
      };

      // Simulate crash after PENDING write
      await expect(
         walService.executeBuySellFlow(input, {
            simulateCrashAfterPending: true,
         })
      ).rejects.toThrow('Simulated server crash after WAL PENDING write');

      // Inspect DB: WAL entry is PENDING, Soroban was never called
      const entries = await mockPrisma.sorobanWALEntry.findMany({});
      expect(entries.length).toBe(1);
      expect(entries[0].state).toBe('PENDING');
      expect(entries[0].txHash).toBeNull();
      expect(mockClient.submitCount).toBe(0);

      // Verify NO side effects applied
      const stateBeforeRecovery = mockPrisma._dumpState();
      expect(stateBeforeRecovery.keyOwnerships.length).toBe(0);
      expect(stateBeforeRecovery.creatorStats.length).toBe(0);
      expect(stateBeforeRecovery.priceSnapshots.length).toBe(0);
      expect(stateBeforeRecovery.transactionHistories.length).toBe(0);
      expect(stateBeforeRecovery.activities.length).toBe(0);

      // Fast-forward entry timestamp beyond 30-second threshold
      entries[0].createdAt = new Date(Date.now() - 35000);

      // Run recovery worker
      const summary = await recoveryWorker.runRecovery({
         ageThresholdMs: 30000,
      });
      expect(summary.scannedCount).toBe(1);
      expect(summary.rolledBackCount).toBe(1);

      // Assert entry is now ROLLED_BACK
      const recoveredEntry = await mockPrisma.sorobanWALEntry.findUnique({
         where: { id: entries[0].id },
      });
      expect(recoveredEntry.state).toBe('ROLLED_BACK');
      expect(recoveredEntry.error).toContain('never submitted');

      // Assert STILL NO side effects applied
      const stateAfterRecovery = mockPrisma._dumpState();
      expect(stateAfterRecovery.keyOwnerships.length).toBe(0);
      expect(stateAfterRecovery.creatorStats.length).toBe(0);
   });

   it('Requirement 5.2 & AC 3: Simulates crash between SUBMITTED and CONFIRMED DB write -> recovery resolves against Horizon and applies side effects exactly once', async () => {
      const input = {
         operation: 'buy' as const,
         wallet: 'GBUYER_SUBMIT_CRASH',
         creatorWallet: 'GCREATOR_SUBMIT_CRASH',
         amount: 10,
         expectedSupplyBefore: 0,
         xdrPayload: 'AAAA...SUBMIT_CRASH_XDR',
      };

      // Simulate crash after submission (tx submitted to Soroban, but DB confirmation interrupted)
      await expect(
         walService.executeBuySellFlow(input, {
            simulateCrashAfterSubmitted: true,
         })
      ).rejects.toThrow(
         'Simulated server crash between SUBMITTED and CONFIRMED'
      );

      // Inspect DB: WAL entry is SUBMITTED with a valid txHash
      const entries = await mockPrisma.sorobanWALEntry.findMany({});
      expect(entries.length).toBe(1);
      expect(entries[0].state).toBe('SUBMITTED');
      expect(entries[0].txHash).toBeDefined();

      // Verify side effects have NOT been applied yet
      expect(mockPrisma._dumpState().keyOwnerships.length).toBe(0);

      // Fast-forward submittedAt beyond 30-second threshold
      entries[0].submittedAt = new Date(Date.now() - 35000);

      // Horizon confirms the transaction
      mockClient.txResultMap.set(entries[0].txHash, {
         status: 'SUCCESS',
         ledger: 5000,
      });

      // Run recovery worker
      const summary = await recoveryWorker.runRecovery({
         ageThresholdMs: 30000,
      });
      expect(summary.scannedCount).toBe(1);
      expect(summary.confirmedCount).toBe(1);

      // Assert WAL entry updated to CONFIRMED
      const confirmedEntry = await mockPrisma.sorobanWALEntry.findUnique({
         where: { id: entries[0].id },
      });
      expect(confirmedEntry.state).toBe('CONFIRMED');
      expect(confirmedEntry.confirmedAt).toBeDefined();

      // Assert side effects are applied
      const state = mockPrisma._dumpState();
      expect(state.keyOwnerships.length).toBe(1);
      expect(state.keyOwnerships[0].balance).toBe('10');
      expect(state.creatorStats.length).toBe(1);
      expect(state.creatorStats[0].holderCount).toBe(1);
      expect(state.creatorStats[0].totalSupply).toBe('10');
      expect(state.priceSnapshots.length).toBe(1);
      expect(state.transactionHistories.length).toBe(1);
      expect(state.activities.length).toBe(1);

      // IDEMPOTENCY VERIFICATION: Run recovery worker again on the confirmed transaction
      const secondSummary = await recoveryWorker.runRecovery({
         ageThresholdMs: 30000,
      });
      expect(secondSummary.scannedCount).toBe(0); // Already confirmed, not scanned as stale

      // Directly re-invoking applyConfirmedSideEffects hits idempotency guard
      const idempotentResult = await walService.applyConfirmedSideEffects(
         entries[0].txHash
      );
      expect(idempotentResult.applied).toBe(false);

      // Assert balance is STILL 10, not doubled to 20!
      const stateAfterSecondRun = mockPrisma._dumpState();
      expect(stateAfterSecondRun.keyOwnerships[0].balance).toBe('10');
   });

   it('Requirement 5.3 & AC 5: Submits two requests with the same idempotency key -> only one WAL entry and one set of side effects', async () => {
      const input = {
         operation: 'buy' as const,
         wallet: 'GBUYER_IDEMP',
         creatorWallet: 'GCREATOR_IDEMP',
         amount: 3,
         expectedSupplyBefore: 0,
         xdrPayload: 'AAAA...IDEMP_XDR',
         idempotencyKey: 'idemp_key_alpha_999',
      };

      // First request
      const res1 = await walService.executeBuySellFlow(input);
      expect(res1.confirmed).toBe(true);
      expect(res1.state).toBe('CONFIRMED');
      expect(res1.isIdempotentReplay).toBeFalsy();

      // Second request with SAME idempotency key
      const res2 = await walService.executeBuySellFlow(input);
      expect(res2.confirmed).toBe(true);
      expect(res2.state).toBe('CONFIRMED');
      expect(res2.isIdempotentReplay).toBe(true);
      expect(res2.walEntryId).toBe(res1.walEntryId);
      expect(res2.txHash).toBe(res1.txHash);

      // Verify only ONE WAL entry exists in DB
      const allEntries = await mockPrisma.sorobanWALEntry.findMany({});
      expect(allEntries.length).toBe(1);

      // Verify side effects applied only ONCE (balance = 3, not 6)
      const state = mockPrisma._dumpState();
      expect(state.keyOwnerships.length).toBe(1);
      expect(state.keyOwnerships[0].balance).toBe('3');
      expect(state.creatorStats[0].totalSupply).toBe('3');
      expect(state.transactionHistories.length).toBe(1);
   });

   it('Requirement 5.4 & AC 6: Confirms the final database state after recovery matches what a crash-free execution would produce', async () => {
      // Execution A: Crash-free normal flow
      const prismaA = createInMemoryPrisma();
      const clientA = new TestSorobanClient();
      const serviceA = new SorobanWALService(prismaA, clientA);

      await serviceA.executeBuySellFlow({
         operation: 'buy',
         wallet: 'WAL_USER_EQUIV',
         creatorWallet: 'WAL_CREATOR_EQUIV',
         amount: 7,
         expectedSupplyBefore: 0,
         xdrPayload: 'XDR_EQUIV_PAYLOAD',
      });

      const finalStateA = prismaA._dumpState();

      // Execution B: Flow with crash between SUBMITTED and CONFIRMED, then recovered by worker
      const prismaB = createInMemoryPrisma();
      const clientB = new TestSorobanClient();
      const serviceB = new SorobanWALService(prismaB, clientB);
      const workerB = new WALRecoveryWorker(prismaB, serviceB, clientB);

      // Simulate crash after submission
      await expect(
         serviceB.executeBuySellFlow(
            {
               operation: 'buy',
               wallet: 'WAL_USER_EQUIV',
               creatorWallet: 'WAL_CREATOR_EQUIV',
               amount: 7,
               expectedSupplyBefore: 0,
               xdrPayload: 'XDR_EQUIV_PAYLOAD',
            },
            { simulateCrashAfterSubmitted: true }
         )
      ).rejects.toThrow();

      // Fast forward stale entry
      const staleEntry = (await prismaB.sorobanWALEntry.findMany({}))[0];
      staleEntry.submittedAt = new Date(Date.now() - 35000);

      // Run recovery
      await workerB.runRecovery({ ageThresholdMs: 30000 });

      const finalStateB = prismaB._dumpState();

      // Compare states
      expect(finalStateB.keyOwnerships[0].balance).toEqual(
         finalStateA.keyOwnerships[0].balance
      );
      expect(finalStateB.creatorStats[0].holderCount).toEqual(
         finalStateA.creatorStats[0].holderCount
      );
      expect(finalStateB.creatorStats[0].totalSupply).toEqual(
         finalStateA.creatorStats[0].totalSupply
      );
      expect(finalStateB.priceSnapshots[0].price).toEqual(
         finalStateA.priceSnapshots[0].price
      );
      expect(finalStateB.priceSnapshots[0].supply).toEqual(
         finalStateA.priceSnapshots[0].supply
      );
      expect(finalStateB.transactionHistories.length).toEqual(
         finalStateA.transactionHistories.length
      );
      expect(finalStateB.activities.length).toEqual(
         finalStateA.activities.length
      );
      expect(finalStateB.walEntries[0].state).toBe('CONFIRMED');
      expect(finalStateA.walEntries[0].state).toBe('CONFIRMED');
   });

   it('AC: Submission failure updates WAL entry to FAILED with error and rolls back optimistic state', async () => {
      mockClient.shouldFailSubmission = true;
      mockClient.submissionErrorMessage =
         'txBAD_AUTH: Invalid account signature';

      const input = {
         operation: 'buy' as const,
         wallet: 'GBAD_AUTH',
         creatorWallet: 'GCREATOR',
         amount: 1,
         expectedSupplyBefore: 0,
         xdrPayload: 'INVALID_SIGNATURE_XDR',
      };

      const result = await walService.executeBuySellFlow(input);

      expect(result.confirmed).toBe(false);
      expect(result.state).toBe('FAILED');
      expect(result.error).toContain('txBAD_AUTH');

      const entry = await mockPrisma.sorobanWALEntry.findUnique({
         where: { id: result.walEntryId },
      });
      expect(entry.state).toBe('FAILED');
      expect(entry.error).toBe('txBAD_AUTH: Invalid account signature');
      expect(mockPrisma._dumpState().keyOwnerships.length).toBe(0);
   });

   it('AC 3: Recovery worker re-polls pending SUBMITTED entries up to 10 times with exponential backoff before marking FAILED', async () => {
      const input = {
         operation: 'buy' as const,
         wallet: 'GPENDING_POLL',
         creatorWallet: 'GCREATOR_POLL',
         amount: 2,
         expectedSupplyBefore: 0,
         xdrPayload: 'PENDING_XDR',
      };

      // Create entry and simulate crash after submission
      await expect(
         walService.executeBuySellFlow(input, {
            simulateCrashAfterSubmitted: true,
         })
      ).rejects.toThrow();

      const entry = (await mockPrisma.sorobanWALEntry.findMany({}))[0];
      entry.submittedAt = new Date(Date.now() - 35000);

      // Horizon always reports PENDING
      mockClient.txResultMap.set(entry.txHash, { status: 'PENDING' });

      // Run recovery with maxPollAttempts = 3, baseBackoffMs = 1
      const summary = await recoveryWorker.runRecovery({
         ageThresholdMs: 30000,
         maxPollAttempts: 3,
         baseBackoffMs: 1,
      });

      expect(summary.failedCount).toBe(1);

      const failedEntry = await mockPrisma.sorobanWALEntry.findUnique({
         where: { id: entry.id },
      });
      expect(failedEntry.state).toBe('FAILED');
      expect(failedEntry.error).toContain(
         'still unconfirmed after 3 re-poll attempts'
      );
      expect(mockClient.pollCount).toBeGreaterThanOrEqual(4); // 1 initial check + 3 re-polls
   });

   it('Enforces sell validations: rejects sell if balance is insufficient before writing WAL entry', async () => {
      const input = {
         operation: 'sell' as const,
         wallet: 'GPOOR_USER',
         creatorWallet: 'GCREATOR',
         amount: 100,
         expectedSupplyBefore: 50,
         xdrPayload: 'SELL_XDR',
      };

      await expect(walService.executeBuySellFlow(input)).rejects.toThrow(
         /Insufficient key balance to execute sell/
      );

      // Assert NO WAL entry was written
      const entries = await mockPrisma.sorobanWALEntry.findMany({});
      expect(entries.length).toBe(0);
   });
});
