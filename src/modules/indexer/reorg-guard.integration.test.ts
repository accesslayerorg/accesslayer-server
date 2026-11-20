// src/modules/indexer/reorg-guard.integration.test.ts
// Integration tests for #724 — reorg-aware Stellar event ingestion.
//
// These run against a real Postgres instance (see docker-compose.yml —
// `pnpm db:up`), not against the mocked Prisma client from jest.setup.ts,
// because the whole point of the reorg guard is the database state it
// rolls back and re-ingests.
//
// Scenario modelled below:
//   shared   L100 (hash LH100)         buyer1 buys 5 @ 1.0 XLM
//   forked   L101F (hash LF101)        buyer2 buys 3 @ 1.1 XLM   (abandoned)
//   forked   L102F (hash LF102)        buyer1 buys 1 @ 1.2 XLM   (abandoned)
//   canonical L101C (hash LC101)       buyer2 buys 3 @ 1.1 XLM
//   canonical L102C (hash LC102)       buyer1 sells 2 @ 1.3 XLM
//
// The forked branch is ingested first; then canonical L102C arrives whose
// previousLedgerHash (LC101) no longer matches the stored hash of L101
// (LF101), which triggers detection, rollback to the fork point L100,
// re-ingestion of canonical L101C, and ingestion of L102C.
//
// The "identical final state" acceptance criterion is verified by running
// the canonical chain cleanly through a control creator and comparing the
// full normalized read-model state against the reorged creator's state.

jest.unmock('@prisma/client');

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   ingestLedger,
   recordLedgerIngestion,
   rollbackToLedger,
   type LedgerHeader,
} from './reorg-guard.service';
import type { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

const PREFIX = 'reorg724';
const RUN_ID = `${PREFIX}-${Date.now().toString(36)}`;

const H_L99 = 'hash-L99';
const H_L100 = 'hash-L100';
const H_L101F = 'hash-L101F';
const H_L102F = 'hash-L102F';
const H_L101C = 'hash-L101C';
const H_L102C = 'hash-L102C';

const T100 = '2026-01-01T00:00:00.000Z';
const T101 = '2026-01-01T00:00:05.000Z';
const T102 = '2026-01-01T00:00:10.000Z';

const HEADER_L100: LedgerHeader = {
   sequence: 100,
   hash: H_L100,
   previousLedgerHash: H_L99,
};
const HEADER_L101F: LedgerHeader = {
   sequence: 101,
   hash: H_L101F,
   previousLedgerHash: H_L100,
};
const HEADER_L102F: LedgerHeader = {
   sequence: 102,
   hash: H_L102F,
   previousLedgerHash: H_L101F,
};
const HEADER_L101C: LedgerHeader = {
   sequence: 101,
   hash: H_L101C,
   previousLedgerHash: H_L100,
};
const HEADER_L102C: LedgerHeader = {
   sequence: 102,
   hash: H_L102C,
   previousLedgerHash: H_L101C,
};

function buyEvent(
   tag: string,
   ledger: number,
   actor: string,
   creatorId: string,
   amount: number,
   priceStroops: bigint,
   tradeAt: string,
   eventIndex = 0
): IndexerChainEvent {
   return {
      txHash: `tx724-${tag}-L${ledger}`,
      eventIndex,
      eventType: 'KEY_BOUGHT',
      ledger,
      creatorId,
      actor,
      amount,
      price: priceStroops,
      feePaid: BigInt(5_000),
      tradeAt,
   };
}

function sellEvent(
   tag: string,
   ledger: number,
   actor: string,
   creatorId: string,
   amount: number,
   priceStroops: bigint,
   tradeAt: string,
   eventIndex = 0
): IndexerChainEvent {
   return {
      txHash: `tx724-${tag}-L${ledger}`,
      eventIndex,
      eventType: 'KEY_SOLD',
      ledger,
      creatorId,
      actor,
      amount,
      price: priceStroops,
      feePaid: BigInt(5_000),
      tradeAt,
   };
}

async function seedCreator(tag: string): Promise<string> {
   const userId = `${PREFIX}-user-${tag}-${RUN_ID}`;
   await prisma.user.upsert({
      where: { id: userId },
      create: {
         id: userId,
         email: `${PREFIX}-${tag}-${RUN_ID}@example.test`,
         passwordHash: 'dummy-hash',
         firstName: 'Reorg',
         lastName: 'Test',
      },
      update: {},
   });
   const creator = await prisma.creatorProfile.upsert({
      where: { handle: `${PREFIX}-${tag}-${RUN_ID}` },
      create: {
         userId,
         handle: `${PREFIX}-${tag}-${RUN_ID}`,
         displayName: `Reorg ${tag}`,
      },
      update: {},
   });
   return creator.id;
}

/**
 * Collect the complete normalized read-model state produced by ingestion
 * for one creator + wallet set, so two runs that consumed the same
 * canonical events can be compared for equality. Run-specific identifiers
 * (creator id, wallet addresses, tx hashes) are replaced by role tokens.
 */
async function captureState(
   creatorId: string,
   roleByWallet: Map<string, string>
): Promise<unknown> {
   const wallets = [...roleByWallet.keys()];

   const ownership = await prisma.keyOwnership.findMany({
      where: { creatorId, ownerAddress: { in: wallets } },
      orderBy: { ownerAddress: 'asc' },
   });

   const activities = await prisma.activity.findMany({
      where: { creatorId, type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
   });

   const profile = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { circulatingSupply: true, currentMilestone: true },
   });

   const snapshot = await prisma.creatorPriceSnapshot.findUnique({
      where: { creatorId },
   });

   const priceHistory = await prisma.creatorPriceHistory.findMany({
      where: { creatorId },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
   });

   const holdingSnapshots = await prisma.walletHoldingSnapshot.findMany({
      where: { creatorId, ownerAddress: { in: wallets } },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
   });

   // Only CONFIRMED events are compared: a reorged run intentionally keeps
   // extra REORGED audit rows, which is asserted separately in the
   // detection test.
   const ingestedEvents = await prisma.ingestedEvent.findMany({
      where: { creatorId, status: 'CONFIRMED' },
      orderBy: [{ ledgerSequence: 'asc' }, { eventIndex: 'asc' }],
   });

   const checkpoints = await prisma.ledgerCheckpoint.findMany({
      where: { ledger: { in: [100, 101, 102] } },
      orderBy: { ledger: 'asc' },
   });

   return {
      ownership: ownership.map(row => ({
         wallet: roleByWallet.get(row.ownerAddress),
         balance: Number(row.balance),
         costBasis: Number(row.costBasis ?? 0),
         realisedPnl: Number(row.realisedPnl ?? 0),
         lastBuyAt: row.lastBuyAt?.toISOString() ?? null,
      })),
      activities: activities.map(row => ({
         type: row.type,
         wallet: roleByWallet.get(row.actor),
         amount: (row.payload as any)?.amount,
         priceAtTrade: (row.payload as any)?.price_at_trade,
         ledgerSequence: (row.payload as any)?.ledger_sequence,
         createdAt: row.createdAt.toISOString(),
      })),
      profile: {
         circulatingSupply:
            profile?.circulatingSupply !== null && profile?.circulatingSupply !== undefined
               ? Number(profile.circulatingSupply)
               : null,
         currentMilestone: profile?.currentMilestone ?? null,
      },
      priceSnapshot: snapshot
         ? {
              currentPrice: snapshot.currentPrice.toString(),
              price24hAgo: snapshot.price24hAgo.toString(),
              lastTradeAt: snapshot.lastTradeAt?.toISOString() ?? null,
           }
         : null,
      priceHistory: priceHistory.map(row => ({
         price: row.price.toString(),
         supply: row.supply.toString(),
         direction: row.direction,
         recordedAt: row.recordedAt.toISOString(),
      })),
      holdingSnapshots: holdingSnapshots.map(row => ({
         wallet: roleByWallet.get(row.ownerAddress),
         balance: Number(row.balance),
         recordedAt: row.recordedAt.toISOString(),
      })),
      ingestedEvents: ingestedEvents.map(row => ({
         ledgerSequence: row.ledgerSequence,
         ledgerHash: row.ledgerHash,
         role: row.actor ? roleByWallet.get(row.actor) ?? row.actor : null,
         eventType: row.eventType,
         amount: row.amount,
         priceStroops: row.priceStroops,
         status: row.status,
      })),
      checkpoints: checkpoints.map(row => ({
         ledger: row.ledger,
         ledgerHash: row.ledgerHash,
         previousLedgerHash: row.previousLedgerHash,
         lastProcessedEventIndex: row.lastProcessedEventIndex,
      })),
   };
}

async function cleanup(): Promise<void> {
   const creators = await prisma.creatorProfile.findMany({
      where: { handle: { startsWith: `${PREFIX}-` } },
      select: { id: true },
   });
   const creatorIds = creators.map(c => c.id);

   await prisma.ingestedEvent.deleteMany({
      where: { txHash: { startsWith: `tx724-` } },
   });
   await prisma.ledgerCheckpoint.deleteMany({
      where: { ledger: { in: [99, 100, 101, 102] } },
   });
   if (creatorIds.length > 0) {
      await prisma.activity.deleteMany({
         where: { creatorId: { in: creatorIds } },
      });
      await prisma.keyOwnership.deleteMany({
         where: { creatorId: { in: creatorIds } },
      });
      await prisma.creatorPriceHistory.deleteMany({
         where: { creatorId: { in: creatorIds } },
      });
      await prisma.creatorPriceSnapshot.deleteMany({
         where: { creatorId: { in: creatorIds } },
      });
      await prisma.walletHoldingSnapshot.deleteMany({
         where: { creatorId: { in: creatorIds } },
      });
      await prisma.creatorProfile.deleteMany({
         where: { id: { in: creatorIds } },
      });
   }
   await prisma.user.deleteMany({
      where: { email: { startsWith: `${PREFIX}-` } },
   });
}

describe('#724 reorg-aware ingestion — integration', () => {
   // Each test starts from a clean slate: the checkpoint and ingested-event
   // tables are global, so leftover rows from a previous test would skew
   // reorg detection and rollback counts.
   beforeEach(async () => {
      await cleanup();
   });

   afterAll(async () => {
      await cleanup();
      await prisma.$disconnect();
   });

   describe('clean ingestion', () => {
      it('advances the checkpoint with hash and sequence for every ingested ledger', async () => {
         const creatorId = await seedCreator('clean');
         const buyer1 = `${PREFIX}-w1-${RUN_ID}`;

         await ingestLedger(HEADER_L100, [
            buyEvent('clean', 100, buyer1, creatorId, 5, 10_000_000n, T100),
         ]);
         await ingestLedger(HEADER_L101C, [
            buyEvent('clean', 101, buyer1, creatorId, 2, 11_000_000n, T101),
         ]);

         const checkpoints = await prisma.ledgerCheckpoint.findMany({
            where: { ledger: { in: [100, 101] } },
            orderBy: { ledger: 'asc' },
         });
         expect(checkpoints).toHaveLength(2);
         expect(checkpoints[0]).toMatchObject({
            ledger: 100,
            ledgerHash: H_L100,
            previousLedgerHash: H_L99,
         });
         expect(checkpoints[1]).toMatchObject({
            ledger: 101,
            ledgerHash: H_L101C,
            previousLedgerHash: H_L100,
         });

         // Every ingested event is recorded with its sequence + hash.
         const events = await prisma.ingestedEvent.findMany({
            where: { creatorId },
            orderBy: [{ ledgerSequence: 'asc' }, { eventIndex: 'asc' }],
         });
         expect(events).toHaveLength(2);
         expect(events[0]).toMatchObject({
            ledgerSequence: 100,
            ledgerHash: H_L100,
            eventType: 'KEY_BOUGHT',
            amount: '5',
            priceStroops: '10000000',
            status: 'CONFIRMED',
         });
         expect(events[1]).toMatchObject({
            ledgerSequence: 101,
            ledgerHash: H_L101C,
            status: 'CONFIRMED',
         });

         // A ledger that chains correctly reports no reorg.
         const result = await ingestLedger(
            { sequence: 102, hash: H_L102C, previousLedgerHash: H_L101C },
            [sellEvent('clean', 102, buyer1, creatorId, 1, 13_000_000n, T102)]
         );
         expect(result.reorgDetected).toBe(false);
         expect(result.eventsIngested).toBe(1);
      });
   });

   describe('reorg detection and rollback', () => {
      it('detects the hash mismatch, rolls back to the fork point, re-ingests, and emits the warn log', async () => {
         const warnSpy = jest.spyOn(logger, 'warn');
         const creatorId = await seedCreator('reorg');
         const buyer1 = `${PREFIX}-rw1-${RUN_ID}`;
         const buyer2 = `${PREFIX}-rw2-${RUN_ID}`;

         const events100 = [
            buyEvent('reorg', 100, buyer1, creatorId, 5, 10_000_000n, T100),
         ];
         const events101F = [
            buyEvent('reorgF', 101, buyer2, creatorId, 3, 11_500_000n, T101),
         ];
         const events102F = [
            buyEvent('reorgF', 102, buyer1, creatorId, 1, 12_500_000n, T102),
         ];
         const events101C = [
            buyEvent('reorgC', 101, buyer2, creatorId, 3, 11_000_000n, T101),
         ];
         const events102C = [
            sellEvent('reorgC', 102, buyer1, creatorId, 2, 13_000_000n, T102),
         ];

         // Ingest the branch that will be abandoned.
         await ingestLedger(HEADER_L100, events100);
         await ingestLedger(HEADER_L101F, events101F);
         await ingestLedger(HEADER_L102F, events102F);

         // Sanity: forked-branch state is in place.
         const forkedBalance = await prisma.keyOwnership.findUnique({
            where: {
               ownerAddress_creatorId: {
                  ownerAddress: buyer1,
                  creatorId,
               },
            },
         });
         expect(Number(forkedBalance?.balance)).toBe(6); // 5 + 1

         warnSpy.mockClear();

         // Canonical L102C arrives: its previousLedgerHash (LC101) does not
         // match the stored hash of L101 (LF101) → reorg.
         const result = await ingestLedger(HEADER_L102C, events102C, {
            fetchHeader: async seq =>
               seq === 101 ? HEADER_L101C : seq === 102 ? HEADER_L102C : null,
            fetchEvents: async seq => (seq === 101 ? events101C : []),
         });

         expect(result.reorgDetected).toBe(true);
         expect(result.forkPoint).toBe(100);
         expect(result.reorgedLedgerCount).toBe(2); // L101F + L102F
         expect(result.affectedEventCount).toBe(2); // one event per forked ledger
         expect(result.reingestedLedgers).toEqual([101]);

         // Warn-level structured log with fork point and affected counts.
         const reorgWarn = warnSpy.mock.calls.find(
            call => call[1] === 'Ledger reorg detected — rolled back database state from the fork point'
         );
         expect(reorgWarn).toBeDefined();
         const fields = reorgWarn![0] as Record<string, unknown>;
         expect(fields.forkPoint).toBe(100);
         expect(fields.reorgedLedgerCount).toBe(2);
         expect(fields.affectedEventCount).toBe(2);

         // The forked events are marked REORGED, the canonical ones
         // CONFIRMED, and no forked checkpoint survives.
         const events = await prisma.ingestedEvent.findMany({
            where: { creatorId },
            orderBy: [{ ledgerSequence: 'asc' }, { eventIndex: 'asc' }],
         });
         expect(
            events.map(e => [e.ledgerSequence, e.status, e.ledgerHash])
         ).toEqual([
            [100, 'CONFIRMED', H_L100],
            [101, 'REORGED', H_L101F],
            [101, 'CONFIRMED', H_L101C],
            [102, 'REORGED', H_L102F],
            [102, 'CONFIRMED', H_L102C],
         ]);
         expect(events[1].reorgedAt).not.toBeNull();

         const checkpoints = await prisma.ledgerCheckpoint.findMany({
            where: { ledger: { in: [100, 101, 102] } },
            orderBy: { ledger: 'asc' },
         });
         expect(checkpoints.map(c => [c.ledger, c.ledgerHash])).toEqual([
            [100, H_L100],
            [101, H_L101C],
            [102, H_L102C],
         ]);

         // Final balances reflect only the canonical chain:
         // buyer1: 5 (L100) - 2 (sell at L102C) = 3; buyer2: 3 (L101C).
         const [b1, b2] = await Promise.all([
            prisma.keyOwnership.findUnique({
               where: {
                  ownerAddress_creatorId: {
                     ownerAddress: buyer1,
                     creatorId,
                  },
               },
            }),
            prisma.keyOwnership.findUnique({
               where: {
                  ownerAddress_creatorId: {
                     ownerAddress: buyer2,
                     creatorId,
                  },
               },
            }),
         ]);
         expect(Number(b1?.balance)).toBe(3);
         expect(Number(b2?.balance)).toBe(3);

         // Only canonical activities remain (3), and no Trade rows leaked.
         const activities = await prisma.activity.findMany({
            where: { creatorId, type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] } },
         });
         expect(activities).toHaveLength(3);
         const supply = await prisma.creatorProfile.findUnique({
            where: { id: creatorId },
            select: { circulatingSupply: true },
         });
         expect(Number(supply?.circulatingSupply)).toBe(6); // 5 + 3 - 2

         warnSpy.mockRestore();
      });

      it('fully reverses rolled-back balance, supply, price and history side effects', async () => {
         const creatorId = await seedCreator('reverse');
         const buyer1 = `${PREFIX}-rv1-${RUN_ID}`;
         const buyer2 = `${PREFIX}-rv2-${RUN_ID}`;

         const events100 = [
            buyEvent('reverse', 100, buyer1, creatorId, 5, 10_000_000n, T100),
         ];
         const events101F = [
            buyEvent('reverseF', 101, buyer2, creatorId, 3, 11_500_000n, T101),
         ];
         const events102F = [
            buyEvent('reverseF', 102, buyer1, creatorId, 1, 12_500_000n, T102),
         ];

         await ingestLedger(HEADER_L100, events100);
         await ingestLedger(HEADER_L101F, events101F);
         await ingestLedger(HEADER_L102F, events102F);

         // Directly exercise the rollback for the forked ledgers 101 + 102.
         const rollback = await rollbackToLedger(100);
         expect(rollback.reorgedLedgerCount).toBe(2);
         expect(rollback.affectedEventCount).toBe(2);

         // Balance changes reversed: buyer1 back to 5, buyer2 back to 0.
         const [b1, b2] = await Promise.all([
            prisma.keyOwnership.findUnique({
               where: {
                  ownerAddress_creatorId: {
                     ownerAddress: buyer1,
                     creatorId,
                  },
               },
            }),
            prisma.keyOwnership.findUnique({
               where: {
                  ownerAddress_creatorId: {
                     ownerAddress: buyer2,
                     creatorId,
                  },
               },
            }),
         ]);
         expect(Number(b1?.balance)).toBe(5);
         expect(Number(b1?.costBasis)).toBeCloseTo(1.0, 7);
         expect(Number(b2?.balance)).toBe(0);

         // Transaction history entries from the forked ledgers are gone.
         const activities = await prisma.activity.findMany({
            where: { creatorId, type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] } },
         });
         expect(activities).toHaveLength(1);
         expect(
            (activities[0].payload as any)?.ledger_sequence
         ).toBe(100);

         // Circulating supply recomputed to the surviving history.
         const profile = await prisma.creatorProfile.findUnique({
            where: { id: creatorId },
            select: { circulatingSupply: true },
         });
         expect(Number(profile?.circulatingSupply)).toBe(5);

         // Price snapshot restored to the last surviving trade.
         const snapshot = await prisma.creatorPriceSnapshot.findUnique({
            where: { creatorId },
         });
         expect(snapshot?.currentPrice.toString()).toBe('10000000');
         expect(snapshot?.lastTradeAt?.toISOString()).toBe(T100);
         const history = await prisma.creatorPriceHistory.findMany({
            where: { creatorId },
         });
         expect(history).toHaveLength(1);

         // Post-trade holding snapshots from forked trades removed.
         const snapshots = await prisma.walletHoldingSnapshot.findMany({
            where: { creatorId },
         });
         expect(snapshots).toHaveLength(1);
         expect(Number(snapshots[0].balance)).toBe(5);

         // Checkpoints after the fork point removed; fork point survives.
         const checkpoints = await prisma.ledgerCheckpoint.findMany({
            where: { ledger: { in: [100, 101, 102] } },
         });
         expect(checkpoints).toHaveLength(1);
         expect(checkpoints[0].ledger).toBe(100);

         // Events marked REORGED.
         const reorged = await prisma.ingestedEvent.count({
            where: { creatorId, status: 'REORGED' },
         });
         expect(reorged).toBe(2);
      });

      it('rolls back atomically — a failure mid-rollback leaves all state untouched', async () => {
         const creatorId = await seedCreator('atomic');
         const buyer1 = `${PREFIX}-at1-${RUN_ID}`;
         const buyer2 = `${PREFIX}-at2-${RUN_ID}`;

         await ingestLedger(HEADER_L100, [
            buyEvent('atomic', 100, buyer1, creatorId, 5, 10_000_000n, T100),
         ]);
         await ingestLedger(HEADER_L101F, [
            buyEvent('atomicF', 101, buyer2, creatorId, 4, 11_500_000n, T101),
         ]);

         // Inject an event whose creator does not exist, so the supply
         // recompute step (creatorProfile.update) fails inside the
         // transaction after earlier steps already ran.
         await prisma.ingestedEvent.create({
            data: {
               ledgerSequence: 101,
               ledgerHash: H_L101F,
               txHash: 'tx724-atomic-bogus',
               eventIndex: 9,
               eventType: 'KEY_BOUGHT',
               actor: buyer1,
               creatorId: `${PREFIX}-missing-creator-${RUN_ID}`,
               amount: '1',
            },
         });

         await expect(rollbackToLedger(100)).rejects.toThrow();

         // Nothing changed: history, balances, checkpoints, event statuses.
         const activities = await prisma.activity.findMany({
            where: { creatorId, type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] } },
         });
         expect(activities).toHaveLength(2);

         const balance = await prisma.keyOwnership.findUnique({
            where: {
               ownerAddress_creatorId: {
                  ownerAddress: buyer2,
                  creatorId,
               },
            },
         });
         expect(Number(balance?.balance)).toBe(4);

         const checkpoints = await prisma.ledgerCheckpoint.findMany({
            where: { ledger: { in: [100, 101] } },
         });
         expect(checkpoints).toHaveLength(2);

         const statuses = await prisma.ingestedEvent.findMany({
            where: { txHash: { startsWith: 'tx724-atomic' } },
            select: { status: true },
         });
         expect(statuses.every(s => s.status === 'CONFIRMED')).toBe(true);
      });
   });

   describe('identical final state after re-ingestion', () => {
      it('produces the same read-model state as if the reorg never happened', async () => {
         // ── Control run: canonical chain ingested cleanly. ────────────
         const controlCreator = await seedCreator('control');
         const cBuyer1 = `${PREFIX}-c1-${RUN_ID}`;
         const cBuyer2 = `${PREFIX}-c2-${RUN_ID}`;

         await ingestLedger(HEADER_L100, [
            buyEvent('ctrl', 100, cBuyer1, controlCreator, 5, 10_000_000n, T100),
         ]);
         await ingestLedger(HEADER_L101C, [
            buyEvent('ctrlC', 101, cBuyer2, controlCreator, 3, 11_000_000n, T101),
         ]);
         await ingestLedger(HEADER_L102C, [
            sellEvent('ctrlC', 102, cBuyer1, controlCreator, 2, 13_000_000n, T102),
         ]);

         // Capture the control state now: the reorg rollback below is
         // global (one canonical chain), so it also touches the control
         // creator's rows in the shared tables.
         const controlState = await captureState(controlCreator, new Map([
            [cBuyer1, 'buyer1'],
            [cBuyer2, 'buyer2'],
         ]));

         // ── Reorg run: forked branch first, then canonical chain. ─────
         const reorgCreator = await seedCreator('finalstate');
         const rBuyer1 = `${PREFIX}-f1-${RUN_ID}`;
         const rBuyer2 = `${PREFIX}-f2-${RUN_ID}`;

         await ingestLedger(HEADER_L100, [
            buyEvent('fs', 100, rBuyer1, reorgCreator, 5, 10_000_000n, T100),
         ]);
         await ingestLedger(HEADER_L101F, [
            buyEvent('fsF', 101, rBuyer2, reorgCreator, 3, 11_500_000n, T101),
         ]);
         await ingestLedger(HEADER_L102F, [
            buyEvent('fsF', 102, rBuyer1, reorgCreator, 1, 12_500_000n, T102),
         ]);

         const result = await ingestLedger(HEADER_L102C, [
            sellEvent('fsC', 102, rBuyer1, reorgCreator, 2, 13_000_000n, T102),
         ], {
            fetchHeader: async seq =>
               seq === 101 ? HEADER_L101C : seq === 102 ? HEADER_L102C : null,
            fetchEvents: async seq =>
               seq === 101
                  ? [
                       buyEvent('fsC', 101, rBuyer2, reorgCreator, 3, 11_000_000n, T101),
                    ]
                  : [],
         });
         expect(result.reorgDetected).toBe(true);
         expect(result.forkPoint).toBe(100);

         const reorgState = await captureState(reorgCreator, new Map([
            [rBuyer1, 'buyer1'],
            [rBuyer2, 'buyer2'],
         ]));

         expect(reorgState).toEqual(controlState);
      });
   });

   describe('recordLedgerIngestion idempotency', () => {
      it('upserts the same checkpoint and event rows on replay', async () => {
         const creatorId = await seedCreator('idem');
         const buyer1 = `${PREFIX}-id1-${RUN_ID}`;
         const events = [
            buyEvent('idem', 100, buyer1, creatorId, 5, 10_000_000n, T100),
         ];

         await recordLedgerIngestion(HEADER_L100, events);
         await recordLedgerIngestion(HEADER_L100, events);

         const checkpoints = await prisma.ledgerCheckpoint.count({
            where: { ledger: 100 },
         });
         expect(checkpoints).toBe(1);

         const ingested = await prisma.ingestedEvent.count({
            where: { txHash: events[0].txHash },
         });
         expect(ingested).toBe(1);
      });
   });
});
