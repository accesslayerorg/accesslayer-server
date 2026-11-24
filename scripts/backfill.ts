// scripts/backfill.ts
// Parallel indexer backfill with range sharding and verification (#1337).
//
// Usage:
//   pnpm exec ts-node --transpile-only scripts/backfill.ts \
//     --contract C... --from 1000000 --to 2000000 --shards 16 \
//     [--concurrency 4] [--rps 5] [--page-size 200] \
//     [--source-url https://worker.example/export] [--verify] [--dry-run] \
//     [--allow-live-range]
//
// --source-url defaults to BACKFILL_EVENT_SOURCE_URL. The source is the indexer
// worker's export endpoint (see src/modules/indexer/backfill/backfill-source.ts).
//
// Safety:
// - By default the range must end at or below the live indexer's cursor, so the
//   backfill only touches finalised history. --allow-live-range overrides this.
// - The live cursor is never advanced (advanceCursor: false).
// - Re-running the same arguments resumes; completed shards are skipped.
//
// Exit codes: 0 success, 1 failed shards or verification mismatches, 2 bad usage.

import 'dotenv/config';
import { buildBackfillPlan, validateBackfillRequest, BackfillRequest } from '../src/modules/indexer/backfill/backfill-plan';
import { runBackfill, verifyBackfillRun } from '../src/modules/indexer/backfill/backfill-runner';
import { createHttpEventSource, BackfillEvent } from '../src/modules/indexer/backfill/backfill-source';
import { createPrismaBackfillStore, countIngestedEventsInRange } from '../src/modules/indexer/backfill/backfill-store';
import { createThrottle } from '../src/modules/indexer/backfill/backfill-throttle';
import { processIndexerEvents } from '../src/modules/indexer/indexer-pipeline.service';
import { IndexerChainEvent } from '../src/utils/indexer-event-processor.utils';
import { prisma } from '../src/utils/prisma.utils';
import { logger } from '../src/utils/logger.utils';

const USAGE =
   'Usage: backfill.ts --contract <C…> --from <ledger> --to <ledger> --shards <n> ' +
   '[--concurrency n] [--rps n] [--page-size n] [--source-url url] [--verify] [--dry-run] [--allow-live-range]';

interface CliOptions {
   request: BackfillRequest;
   concurrency: number;
   requestsPerSecond: number;
   pageSize: number;
   sourceUrl: string | undefined;
   verify: boolean;
   dryRun: boolean;
   allowLiveRange: boolean;
}

export function parseCli(argv: string[]): CliOptions {
   const flags = new Map<string, string | true>();
   for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (['verify', 'dry-run', 'allow-live-range'].includes(name)) {
         flags.set(name, true);
      } else {
         if (next === undefined || next.startsWith('--')) throw new Error(`--${name} needs a value`);
         flags.set(name, next);
         i += 1;
      }
   }

   const num = (name: string, fallback?: number): number => {
      const raw = flags.get(name);
      if (raw === undefined) {
         if (fallback === undefined) throw new Error(`--${name} is required`);
         return fallback;
      }
      return Number(raw);
    };

   const contractId = flags.get('contract');
   if (typeof contractId !== 'string') throw new Error('--contract is required');

   return {
      request: {
         contractId,
         fromLedger: num('from'),
         toLedger: num('to'),
         shards: num('shards'),
      },
      concurrency: num('concurrency', 4),
      requestsPerSecond: num('rps', 5),
      pageSize: num('page-size', 200),
      sourceUrl: typeof flags.get('source-url') === 'string' ? (flags.get('source-url') as string) : process.env.BACKFILL_EVENT_SOURCE_URL,
      verify: flags.has('verify'),
      dryRun: flags.has('dry-run'),
      allowLiveRange: flags.has('allow-live-range'),
   };
}

async function main(): Promise<void> {
   let options: CliOptions;
   try {
      options = parseCli(process.argv.slice(2));
   } catch (error) {
      console.error((error as Error).message);
      console.error(USAGE);
      process.exit(2);
      return;
   }

   const problems = validateBackfillRequest(options.request);
   if (problems.length > 0) {
      console.error(`invalid backfill request: ${problems.join('; ')}`);
      process.exit(2);
      return;
   }

   const plan = buildBackfillPlan(options.request);
   console.log(`run ${plan.runKey}: ${plan.ranges.length} shard(s) over ledgers ${plan.fromLedger}-${plan.toLedger}`);
   if (options.dryRun) {
      for (const range of plan.ranges) {
         console.log(`  shard ${range.shardIndex}: ${range.fromLedger}-${range.toLedger}`);
      }
      return;
   }

   if (!options.sourceUrl) {
      console.error('--source-url (or BACKFILL_EVENT_SOURCE_URL) is required to fetch events');
      process.exit(2);
      return;
   }

   const indexed = await prisma.indexedLedger.findUnique({ where: { id: 1 } });
   if (indexed && plan.toLedger > indexed.ledger && !options.allowLiveRange) {
      console.error(
         `refusing to backfill past the live cursor (ledger ${indexed.ledger}); ` +
            'pass --allow-live-range only if the range is final'
      );
      process.exit(1);
      return;
   }

   const store = createPrismaBackfillStore(prisma);
   const summary = await runBackfill(plan, {
      source: createHttpEventSource({ baseUrl: options.sourceUrl }),
      store,
      applyEvent: async (event: BackfillEvent) => {
         await processIndexerEvents([event as unknown as IndexerChainEvent], { advanceCursor: false });
      },
      concurrency: options.concurrency,
      pageSize: options.pageSize,
      throttle: createThrottle({ requestsPerSecond: options.requestsPerSecond }),
      log: (message, fields) => logger.info(fields, message),
   });
   console.log(JSON.stringify(summary, null, 2));

   let failed = summary.shardsFailed > 0;
   if (options.verify) {
      const report = await verifyBackfillRun(plan.runKey, store, countIngestedEventsInRange(prisma));
      console.log(JSON.stringify(report, null, 2));
      console.log(
         'balance verification against on-chain state is not configured in this CLI; ' +
            'count and accounting checks only'
      );
      failed = failed || report.mismatches.length > 0;
   }

   await prisma.$disconnect();
   process.exit(failed ? 1 : 0);
}

if (require.main === module) {
   main().catch(async error => {
      console.error('backfill failed:', error);
      await prisma.$disconnect();
      process.exit(1);
   });
}
