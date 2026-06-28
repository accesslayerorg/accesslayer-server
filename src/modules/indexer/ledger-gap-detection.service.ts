// src/modules/indexer/ledger-gap-detection.service.ts
// Detects gaps in processed ledger sequences and logs warnings.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';

export interface LedgerGap {
  detected: boolean;
  lastProcessed: number;
  currentNetworkHead: number;
  gapSize: number;
  gapRange: { start: number; end: number } | null;
}

/**
 * Mock Stellar network head ledger for development.
 * In production, this would call the Stellar Horizon/Soroban RPC API.
 */
async function fetchStellarNetworkHead(): Promise<number> {
  // TODO: Replace with actual Stellar RPC call
  // const response = await fetch(`${envConfig.STELLAR_SOROBAN_RPC_URL}/...`);
  // return response.latestLedger;
  return 12_400; // Mock value for dev
}

/**
 * Checks for gaps in the processed ledger sequence.
 *
 * - Compares the last processed ledger against the current network head.
 * - Logs a structured warning when a gap exceeds the threshold.
 * - Called on indexer startup and periodically during operation.
 *
 * @returns Gap detection result with range details.
 */
export async function detectLedgerGap(): Promise<LedgerGap> {
  try {
    const indexedLedger = await prisma.indexedLedger.findFirst({
      orderBy: { updatedAt: 'desc' },
    });

    if (!indexedLedger) {
      logger.warn('No indexed ledger record found — indexer has never run');
      return {
        detected: false,
        lastProcessed: 0,
        currentNetworkHead: 0,
        gapSize: 0,
        gapRange: null,
      };
    }

    const networkHead = await fetchStellarNetworkHead();
    const gapSize = networkHead - indexedLedger.ledger;

    if (gapSize > 10) {
      // Gap threshold: 10 ledgers (~50 seconds at 5s/ledger)
      logger.warn(
        {
          event: 'ledger_gap_detected',
          lastProcessed: indexedLedger.ledger,
          networkHead,
          gapSize,
          gapRange: {
            start: indexedLedger.ledger + 1,
            end: networkHead,
          },
          updatedAt: indexedLedger.updatedAt.toISOString(),
        },
        `Ledger gap detected: ${gapSize} ledgers behind (${indexedLedger.ledger} → ${networkHead})`
      );

      return {
        detected: true,
        lastProcessed: indexedLedger.ledger,
        currentNetworkHead: networkHead,
        gapSize,
        gapRange: {
          start: indexedLedger.ledger + 1,
          end: networkHead,
        },
      };
    }

    return {
      detected: false,
      lastProcessed: indexedLedger.ledger,
      currentNetworkHead: networkHead,
      gapSize,
      gapRange: null,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to detect ledger gap');
    throw err;
  }
}

/**
 * Tracks the highest contiguously processed ledger.
 * Called by the indexer after successfully processing a batch.
 *
 * @param ledger - The ledger sequence number just processed.
 * @param cursor - The opaque cursor for resumption.
 */
export async function updateIndexedLedger(
  ledger: number,
  cursor: string
): Promise<void> {
  await prisma.indexedLedger.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      ledger,
      cursor,
    },
    update: {
      ledger,
      cursor,
    },
  });
}
