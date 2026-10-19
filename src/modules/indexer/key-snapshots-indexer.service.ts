import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { invalidateKeySnapshotsCache } from '../keys/key-snapshots.service';

export const KEY_SNAPSHOT_EVENT_TYPES = [
   'SnapshotTaken',
   'SNAPSHOT_TAKEN',
   'KEY_SNAPSHOT_TAKEN',
] as const;

export function isKeySnapshotEventType(eventType: string): boolean {
   return (KEY_SNAPSHOT_EVENT_TYPES as readonly string[]).includes(eventType);
}

export interface KeySnapshotChainEvent extends IndexerChainEvent {
   keyId?: string;
   creatorId?: string;
   date?: string | number | Date;
   price: string | number;
   volume: string | number;
   holderCount?: number;
   holder_count?: number;
   marketCap?: string | number;
   market_cap?: string | number;
   txHash: string;
   ledger?: number;
   blockNumber?: number | bigint;
}

/**
 * Indexes SnapshotTaken events into key_snapshots table (#1112).
 */
export async function processKeySnapshotEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   const snapshotEvents = events.filter(e => isKeySnapshotEventType(e.eventType));
   if (snapshotEvents.length === 0) return;

   await processIndexerChainEvents(snapshotEvents, async rawEvent => {
      const event = rawEvent as unknown as KeySnapshotChainEvent;
      const keyId = event.keyId || event.creatorId;

      if (!keyId) {
         logger.warn({ rawEvent }, 'SnapshotTaken event missing keyId');
         return;
      }

      const date = event.date ? new Date(event.date) : new Date();
      const price = (event.price ?? '0').toString();
      const volume = (event.volume ?? '0').toString();
      const holderCount = Number(event.holderCount ?? event.holder_count ?? 0);
      const marketCap = (event.marketCap ?? event.market_cap ?? '0').toString();
      const blockNum = event.blockNumber ?? event.ledger ?? null;

      await (prisma as any).keySnapshot.create({
         data: {
            keyId,
            date,
            price,
            volume,
            holderCount,
            marketCap,
            txHash: event.txHash ?? null,
            blockNumber: blockNum !== null ? BigInt(blockNum) : null,
         },
      });

      await invalidateKeySnapshotsCache(keyId);
   });
}
