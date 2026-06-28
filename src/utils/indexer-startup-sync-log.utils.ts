import { prisma } from './prisma.utils';
import { logger } from './logger.utils';

const ESTIMATED_LEDGER_CLOSE_TIME_SECONDS = 5;

/**
 * Emits a structured log showing the indexer's sync state on startup.
 *
 * Logs the last processed ledger, current network ledger, lag in ledgers,
 * and estimated catchup time. If no ledger has been processed yet, emits
 * a warning indicating a fresh start.
 *
 * @param currentNetworkLedger - The current ledger sequence from the Stellar network
 *
 * @example
 * // On startup after connecting to Stellar RPC:
 * const networkLedger = await fetchCurrentLedgerFromHorizon();
 * await logIndexerStartupSyncState(networkLedger);
 */
export async function logIndexerStartupSyncState(
   currentNetworkLedger: number
): Promise<void> {
   const lastProcessedRecord = await prisma.indexerCursor.findFirst({
      orderBy: { last_ledger_sequence: 'desc' },
      select: { last_ledger_sequence: true },
   });

   if (
      !lastProcessedRecord ||
      lastProcessedRecord.last_ledger_sequence === null
   ) {
      logger.warn(
         {
            current_network_ledger: currentNetworkLedger,
            indexer_state: 'fresh_start',
         },
         'Indexer starting from scratch — no ledger has been processed yet'
      );
      return;
   }

   const lastProcessedLedger = lastProcessedRecord.last_ledger_sequence;
   const lagInLedgers = currentNetworkLedger - lastProcessedLedger;
   const estimatedCatchupSeconds =
      lagInLedgers * ESTIMATED_LEDGER_CLOSE_TIME_SECONDS;

   logger.info(
      {
         last_processed_ledger: lastProcessedLedger,
         current_network_ledger: currentNetworkLedger,
         lag_in_ledgers: lagInLedgers,
         estimated_catchup_seconds: estimatedCatchupSeconds,
      },
      'Indexer startup sync state'
   );
}
