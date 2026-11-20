// src/modules/portfolio/holding-snapshot.service.ts
// Holdings snapshots written on every trade event (#1008).
//
// Each row records the balance a wallet held for one key immediately after
// a trade. GET /portfolio/history replays them as-of every interval and
// multiplies by the price recorded at that interval to build the
// value-over-time chart.
//
// Snapshot writes are deliberately non-blocking for the trade itself: a
// failed write is logged and swallowed so history gaps never break trade
// ingestion (same policy as the other read-model side effects).

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';

/** Minimal client shape so transactional callers can pass their `tx`. */
interface SnapshotClient {
   walletHoldingSnapshot: {
      create: (args: {
         data: {
            ownerAddress: string;
            creatorId: string;
            balance: number;
            recordedAt: Date;
         };
      }) => Promise<unknown>;
   };
}

export interface HoldingSnapshotInput {
   /** Wallet whose balance changed (the buyer on a buy, the seller on a sell). */
   ownerAddress: string;
   /** Key the balance belongs to. */
   creatorId: string;
   /** Balance immediately after the trade. */
   balance: number;
   /** When the trade occurred; defaults to now for callers without a timestamp. */
   recordedAt?: Date;
   /** Optional transaction client so the snapshot lands with the trade write. */
   db?: SnapshotClient;
}

/**
 * Record the post-trade balance for a wallet/key pair.
 *
 * Never throws: a snapshot failure leaves a gap in the history series but
 * must not fail the trade that produced it.
 */
export async function recordHoldingSnapshot(
   input: HoldingSnapshotInput
): Promise<void> {
   const { ownerAddress, creatorId, balance, recordedAt, db } = input;

   if (!ownerAddress || !creatorId || !Number.isFinite(balance)) {
      return;
   }

   try {
      const client = (db ?? prisma) as SnapshotClient;
      await client.walletHoldingSnapshot.create({
         data: {
            ownerAddress,
            creatorId,
            balance,
            recordedAt: recordedAt ?? new Date(),
         },
      });
   } catch (error) {
      logger.warn(
         {
            type: 'holding_snapshot_write_failed',
            creator_id: creatorId,
            wallet_address: ownerAddress,
            balance,
            error,
         },
         'holding-snapshot: failed to record post-trade balance'
      );
   }
}
