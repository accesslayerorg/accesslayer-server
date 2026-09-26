// src/modules/indexer/indexer-resume.integration.test.ts
// Integration tests for #667 — indexer resumes from checkpoint.ledger + 1
// after a simulated restart.
//
// Scope
//   1. Write a checkpoint record for ledger 5000
//   2. Reinitialise the indexer (simulate restart)
//   3. Assert the indexer begins fetching from ledger 5001
//   4. Assert ledgers 1 through 5000 are not reprocessed
//
// Acceptance Criteria
//   ✅ Indexer resumes from ledger 5001 after checkpoint at 5000
//   ✅ No ledgers below 5001 are reprocessed
//   ✅ Resume ledger read from the checkpoint table, not hardcoded
//   ✅ Test passes when the checkpoint table has multiple records (most recent is used)

import { prisma } from '../../utils/prisma.utils';
import {
   writeCheckpoint,
   readLatestCheckpoint,
   getResumePoint,
   computeBatchHash,
} from './ledger-checkpoint.service';
import { processTradeEvents } from './indexer-pipeline.service';
import type { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

describe('#667 indexer resumes from checkpoint after simulated restart', () => {
   beforeEach(async () => {
      // Clean slate before every test so checkpoints, activities and
      // read-model rows from earlier tests do not leak into subsequent
      // assertions.
      await prisma.ledgerCheckpoint.deleteMany({});
      await prisma.activity.deleteMany({});
      await prisma.indexedLedger.deleteMany({});
      await prisma.keyOwnership.deleteMany({});
      await prisma.creatorPriceSnapshot.deleteMany({});
      jest.restoreAllMocks();
   });

   afterAll(async () => {
      await prisma.ledgerCheckpoint.deleteMany({});
      await prisma.activity.deleteMany({});
      await prisma.indexedLedger.deleteMany({});
      await prisma.keyOwnership.deleteMany({});
      await prisma.creatorPriceSnapshot.deleteMany({});
      jest.restoreAllMocks();
      await prisma.$disconnect();
   });

   // -------------------------------------------------------------------
   // PRIMARY SCENARIO: the exact scenario from issue #667
   // -------------------------------------------------------------------
   describe('primary scenario — checkpoint at ledger 5000, restart, resume from 5001', () => {
      it('writes a checkpoint for ledger 5000 and resumes from ledger 5001 after restart', async () => {
         // STEP 1: Write a checkpoint record for ledger 5000 — mirrors
         // the pre-restart state where the indexer finished processing
         // all events in ledger 5000.
         const batchHash = computeBatchHash(['tx-pre-restart:0']);
         const written = await writeCheckpoint(5000, 12, batchHash);

         expect(written).not.toBeNull();
         expect(written!.ledger).toBe(5000);
         expect(written!.lastProcessedEventIndex).toBe(12);
         expect(written!.batchHash).toBe(batchHash);

         // Verify the checkpoint is persisted — not just returned from
         // the upsert result.
         const persisted = await readLatestCheckpoint();
         expect(persisted).not.toBeNull();
         expect(persisted!.ledger).toBe(5000);
         expect(persisted!.batchHash).toBe(batchHash);

         // STEP 2: Simulate restart by reinitialising the indexer. The
         // contract being tested here: getResumePoint() returns
         // checkpoint.ledger + 1 — the exact ledger the indexer must
         // start fetching from on next boot.
         const resumeFrom = await getResumePoint();

         // STEP 3: Assert the indexer begins fetching from ledger 5001.
         expect(resumeFrom).toBe(5001);
      });
   });

   // -------------------------------------------------------------------
   // MOST-RECENT CHECKPOINT selection when multiple rows exist
   // -------------------------------------------------------------------
   describe('most-recent-checkpoint is selected when multiple records exist', () => {
      it('selects the highest ledger record and returns ledger + 1', async () => {
         // Seed three checkpoints across distinct ledger values. The
         // schema permits multiple rows (`@@unique([ledger])` is
         // per-ledger — there is no constraint limiting the table to
         // one row), so the "most recent" selection must be exercised
         // explicitly.
         await writeCheckpoint(100, 0, computeBatchHash(['tx-100:0']));
         await writeCheckpoint(2000, 3, computeBatchHash(['tx-2000:0']));
         await writeCheckpoint(5000, 5, computeBatchHash(['tx-5000:0']));

         // Confirm all three checkpoints are persisted as distinct rows
         // so the "most recent is used" assertion is meaningful.
         const all = await prisma.ledgerCheckpoint.findMany({
            orderBy: { ledger: 'desc' },
         });
         expect(all).toHaveLength(3);
         expect(all.map(c => c.ledger)).toEqual([5000, 2000, 100]);

         // Simulate restart and resume from the highest record + 1.
         const resumeFrom = await getResumePoint();

         expect(resumeFrom).toBe(5001);
      });
   });

   // -------------------------------------------------------------------
   // RESUME VALUE IS SOURCED FROM THE CHECKPOINT TABLE, not hardcoded
   // -------------------------------------------------------------------
   describe('resume ledger is sourced from the checkpoint table, not a hardcoded constant', () => {
      it('returns ledger + 1 for a checkpoint at non-5000 ledger', async () => {
         // Use ledger 9999 — a value that any hardcoded constant like
         // 5001 could never produce. This proves the resume ledger is
         // read from the database, not baked into the source.
         await writeCheckpoint(9999, 0, computeBatchHash(['tx-9999:0']));

         const resumeFrom = await getResumePoint();

         expect(resumeFrom).toBe(10_000);
      });

      it('returns 0 on first run when the checkpoint table is empty', async () => {
         // beforeEach already cleared the table — first run state.
         const resumeFrom = await getResumePoint();
         expect(resumeFrom).toBe(0);
      });
   });

   // -------------------------------------------------------------------
   // NO LEDGERS BELOW THE RESUME POINT ARE REPROCESSED
   // -------------------------------------------------------------------
   //
   // Contract under test:
   //   - The `ledger_checkpoint` table is the source of truth for
   //     "where did the indexer leave off".
   //   - After restart, the indexer resumes at `checkpoint.ledger + 1`.
   //   - Pre-existing activity rows from earlier ledgers remain
   //     untouched — they are NOT re-fetched, re-validated, or replayed.
   //
   // Important note about processTradeEvents:
   //   processTradeEvents does NOT filter input events by ledger. The
   //   "no ledgers below are reprocessed" guarantee comes from the
   //   indexer's polling loop — it only fetches events ≥ the resume
   //   point supplied by getResumePoint(). This test verifies both
   //   halves of the contract together:
   //     (a) the resume point itself is correct (= ledger + 1, from DB),
   //     (b) the only writes that happen during the post-restart run
   //         touch ledgers ≥ the resume point.
   //
   describe('no ledgers below the resume point are reprocessed', () => {
      it('after restart at checkpoint 5000, pre-existing activity rows are untouched and only events at ledgers ≥ 5001 are written', async () => {
         // ============================================================
         // ARRANGE — pre-restart state
         // ============================================================
         //
         // 1) Persist "historical" activity rows that the indexer wrote
         //    *before* the simulated restart. They all live at ledgers
         //    < 5001 and represent the indexer's earlier work. After
         //    restart, the indexer must NOT touch them again.
         //
         //    Three rows are enough: one small, one mid-range, and one
         //    at the boundary (`4999`, immediately below the resume
         //    point).
         const historicLedgers = [100, 2500, 4999];
         for (const ledger of historicLedgers) {
            await prisma.activity.create({
               data: {
                  type: 'KEY_SOLD',
                  actor: `G_HISTORIC_ACTOR_${ledger}`,
                  creatorId: `historic-creator-${ledger}`,
                  payload: {
                     amount: 1,
                     price_at_trade: '10',
                     fee_paid: '1',
                     ledger_sequence: ledger,
                  },
                  createdAt: new Date(
                     `2026-07-01T00:00:${String(ledger % 60).padStart(2, '0')}Z`
                  ),
               },
            });
         }

         // 2) Write the checkpoint that anchors the restart at ledger 5000.
         await writeCheckpoint(5000, 0, computeBatchHash(['tx-pre-restart:0']));

         // ============================================================
         // ACT — simulate restart and post-restart processing
         // ============================================================
         //
         // Scope-limited mocks via `jest.spyOn` (NOT `jest.mock`) so the
         // real `ledger_checkpoint` connection stays intact. The spies
         // intercept only the read-model operations that
         // processTradeEvents performs, letting us observe the ledgers
         // it WOULD write without polluting the real DB. processTradeEvents
         // extends prisma behind $extends, so its methods require the
         // `PrismaPromise` return shape; `mockImplementation` is cast to
         // `any` for the same reason — we are intentionally replacing
         // the implementation here.
         const processedLedgers: number[] = [];
         jest.spyOn(prisma.activity, 'create').mockImplementation((async ({
            data,
         }: any) => {
            const ledger = data?.payload?.ledger_sequence;
            if (typeof ledger === 'number') {
               processedLedgers.push(ledger);
            }
            return {} as any;
            // cast as any: Prisma's $extends wraps methods as PrismaPromise;
            // jest.spyOn's mockImplementation signature is typed against that
            // shape. We intentionally replace the implementation so we can
            // observe writes. test-only.
         }) as any);

         jest
            .spyOn(prisma.keyOwnership, 'findFirst')
            .mockResolvedValue(null as any);
         jest
            .spyOn(prisma.keyOwnership, 'upsert')
            .mockResolvedValue({ balance: 0 } as any);
         jest
            .spyOn(prisma.creatorPriceSnapshot, 'findUnique')
            .mockResolvedValue(null as any);
         jest
            .spyOn(prisma.creatorPriceSnapshot, 'create')
            .mockResolvedValue({} as any);
         jest
            .spyOn(prisma.indexedLedger, 'upsert')
            .mockResolvedValue({} as any);

         // (a) Simulate restart — read resume point from the
         //     checkpoint table. The value is derived from the DB.
         const resumeFrom = await getResumePoint();
         expect(resumeFrom).toBe(5001);

         // (b) Feed processTradeEvents ONLY events at ledgers ≥ the
         //     resume point. A real indexer would already have used
         //     getResumePoint() to gate its polling loop before reaching
         //     this step, so receiving a sub-resume event would be a
         //     contract violation. We mirror that contract here.
         const eventsAfterRestart: IndexerChainEvent[] = [
            {
               txHash: '0xpost5001',
               eventIndex: 0,
               eventType: 'KEY_SOLD',
               ledger: 5001,
               creatorId: 'resume-creator-1',
               actor: 'G_ACTOR_5001',
               amount: 1,
               price: 100n,
               feePaid: 1n,
               tradeAt: '2026-07-28T00:00:00.000Z',
            },
            {
               txHash: '0xpost5002',
               eventIndex: 0,
               eventType: 'KEY_BOUGHT',
               ledger: 5002,
               creatorId: 'resume-creator-1',
               actor: 'G_ACTOR_5002',
               amount: 2,
               price: 200n,
               feePaid: 2n,
               tradeAt: '2026-07-28T00:01:00.000Z',
            },
            {
               txHash: '0xpost5003',
               eventIndex: 0,
               eventType: 'KEY_SOLD',
               ledger: 5003,
               creatorId: 'resume-creator-1',
               actor: 'G_ACTOR_5003',
               amount: 3,
               price: 300n,
               feePaid: 3n,
               tradeAt: '2026-07-28T00:02:00.000Z',
            },
         ];

         await processTradeEvents(eventsAfterRestart);

         // ============================================================
         // ASSERT
         // ============================================================

         // (1) Spy evidence — observability check, NOT the contract.
         //     The events fed in are above `resumeFrom` by construction
         //     (the filter is enforced by the indexer's polling loop in
         //     production; this test mirrors that contract). The actual
         //     resume-contract assertion is `expect(resumeFrom).toBe(5001)`
         //     earlier in the ACT phase. The spy here confirms the
         //     pipeline reached activity.create for exactly the ledgers
         //     we fed it, with nothing leaked below the resume point.
         expect(processedLedgers).toHaveLength(3);
         expect(processedLedgers).toEqual(
            expect.arrayContaining([5001, 5002, 5003])
         );
         expect(processedLedgers.some(l => l < resumeFrom)).toBe(false);

         // (2) DB-side evidence — the historic sub-5001 activity rows
         //     are still present at the same count, untouched. The
         //     count equality is sufficient: processTradeEvents only
         //     inserts new rows, never deletes or modifies existing
         //     ones, so a row-count delta would be the only meaningful
         //     signal a regression could produce.
         const postHistoricRows = await prisma.activity.findMany({
            where: {
               payload: { path: ['ledger_sequence'], lte: 5000 },
            },
         });
         expect(postHistoricRows).toHaveLength(historicLedgers.length);
         for (const row of postHistoricRows) {
            const ledger = (row.payload as any).ledger_sequence;
            expect(ledger).toBeLessThan(resumeFrom);
         }

         // (3) New (≥ 5001) activity rows did not leak into the DB —
         //     the spy captured them instead. The real DB has zero rows
         //     at ledgers above the resume point.
         const postNewRows = await prisma.activity.findMany({
            where: {
               payload: { path: ['ledger_sequence'], gte: 5001 },
            },
         });
         expect(postNewRows).toHaveLength(0);

         // (4) The checkpoint table is unchanged in shape: exactly
         //     one row for ledger 5000. The post-resume pipeline
         //     relies on this invariant for the NEXT restart.
         const checkpoints = await prisma.ledgerCheckpoint.findMany({
            orderBy: { ledger: 'desc' },
         });
         expect(checkpoints).toHaveLength(1);
         expect(checkpoints[0].ledger).toBe(5000);
      });
   });
});
