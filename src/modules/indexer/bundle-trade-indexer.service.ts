import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { buildLogFields } from '../../utils/log-fields.utils';
import { guardChainEvent, ChainEvent } from '../../utils/indexer-dedupe.utils';

export interface BundleItem {
   /** Key / Creator ID of the token */
   key: string;
   /** Quantity or amount purchased */
   amount: number | string;
   /** Price per unit or total cost for this leg */
   price: string | number;
   /** Compatibility fields */
   creator?: string;
   creatorId?: string;
   creator_id?: string;
   quantity?: number | string;
}

export interface BundleExecutedEvent {
   /** Buyer's Stellar wallet address */
   buyer?: string;
   wallet?: string;
   actor?: string;
   /** Total cost across all items in the bundle (in stroops or XLM) */
   total_cost?: string | number;
   totalCost?: string | number;
   /** Number of items in the bundle */
   item_count?: number;
   itemCount?: number;
   /** Per-item breakdown */
   items?: BundleItem[];
   legs?: BundleItem[];
   /** Ledger sequence number */
   ledger: number;
   /** Transaction hash */
   tx_hash?: string;
   txHash?: string;
   /** Event index within the transaction */
   eventIndex?: number;
   event_index?: number;
   /** On-chain timestamp */
   timestamp?: string | Date;
   occurredAt?: string | Date;
   ledgerClosedAt?: string;
   /** Event type tag */
   eventType?: string;
   event_type?: string;
}

export interface NormalizedBundleItem {
   key: string;
   creatorId: string;
   creator_id: string;
   amount: number;
   quantity: number;
   price: string;
}

export interface IndexedBundleTrade {
   id: string;
   wallet: string;
   buyer: string;
   totalCost: string;
   total_cost: string;
   itemCount: number;
   item_count: number;
   items: NormalizedBundleItem[];
   ledger: number;
   txHash: string;
   tx_hash: string;
   timestamp: Date;
   type: 'bundle';
   createdAt?: Date;
}

const REQUIRED_FIELDS = ['wallet', 'ledger', 'txHash', 'timestamp', 'items'];

/**
 * Normalizes a raw or partial BundleExecutedEvent into standard fields.
 */
export function normalizeBundleEvent(event: Partial<BundleExecutedEvent>): {
   wallet: string;
   ledger: number;
   txHash: string;
   timestamp: Date;
   totalCost: string;
   itemCount: number;
   items: NormalizedBundleItem[];
   eventIndex: number;
} | null {
   const wallet = (event.wallet || event.buyer || event.actor || '').trim();
   const txHash = (event.txHash || event.tx_hash || '').trim();
   const ledger =
      typeof event.ledger === 'number' ? event.ledger : Number(event.ledger);
   const rawTimestamp =
      event.timestamp || event.occurredAt || event.ledgerClosedAt;
   const eventIndex =
      typeof event.eventIndex === 'number'
         ? event.eventIndex
         : Number(event.event_index) || 0;

   if (!wallet || !txHash || isNaN(ledger) || !rawTimestamp) {
      return null;
   }

   const parsedDate = new Date(rawTimestamp);
   if (isNaN(parsedDate.getTime())) {
      return null;
   }

   let rawItems = event.items || event.legs;
   if (typeof rawItems === 'string') {
      try {
         rawItems = JSON.parse(rawItems);
      } catch {
         return null;
      }
   }

   if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return null;
   }

   const normalizedItems: NormalizedBundleItem[] = [];
   let computedTotalCost = 0n;

   for (const item of rawItems) {
      if (!item || typeof item !== 'object') {
         return null;
      }
      const key = String(
         item.key || item.creatorId || item.creator_id || item.creator || ''
      ).trim();
      const rawAmount = item.amount ?? item.quantity;
      const numAmount =
         typeof rawAmount === 'number' ? rawAmount : Number(rawAmount);
      const priceStr = String(item.price ?? '0').trim();

      if (!key || isNaN(numAmount) || numAmount <= 0) {
         return null;
      }

      normalizedItems.push({
         key,
         creatorId: key,
         creator_id: key,
         amount: numAmount,
         quantity: numAmount,
         price: priceStr,
      });

      try {
         computedTotalCost += BigInt(priceStr) * BigInt(numAmount);
      } catch {
         const p = Number(priceStr) || 0;
         computedTotalCost += BigInt(Math.floor(p * numAmount));
      }
   }

   const rawTotalCost = event.totalCost ?? event.total_cost;
   const totalCost =
      rawTotalCost !== undefined &&
      rawTotalCost !== null &&
      String(rawTotalCost).trim() !== ''
         ? String(rawTotalCost).trim()
         : computedTotalCost.toString();

   const itemCount =
      typeof event.itemCount === 'number'
         ? event.itemCount
         : typeof event.item_count === 'number'
           ? event.item_count
           : normalizedItems.length;

   return {
      wallet,
      ledger,
      txHash,
      timestamp: parsedDate,
      totalCost,
      itemCount,
      items: normalizedItems,
      eventIndex,
   };
}

/**
 * Indexes a single BundleExecuted contract event.
 * Writes the bundle header and full per-item breakdown into bundle_trades table.
 *
 * Implements deduplication guards:
 * - In-memory seen set check (if provided)
 * - Database lookup on (ledger, txHash) and txHash
 * - Database unique constraint violation catch
 *
 * @param event - The BundleExecuted contract event payload
 * @param db - Prisma client instance (defaults to global prisma)
 * @param seen - Optional Set for tracking processed event hashes/keys in-memory
 * @returns Promise<boolean> - true if newly indexed, false if skipped or duplicate
 */
export async function processBundleTradeEvent(
   event: Partial<BundleExecutedEvent>,
   db: any = prisma,
   seen?: Set<string>
): Promise<boolean> {
   const normalized = normalizeBundleEvent(event);

   if (!normalized) {
      const missing: string[] = [];
      const wallet = (event.wallet || event.buyer || event.actor || '').trim();
      if (!wallet) missing.push('wallet');
      if (typeof event.ledger !== 'number' || isNaN(event.ledger))
         missing.push('ledger');
      const txHash = (event.txHash || event.tx_hash || '').trim();
      if (!txHash) missing.push('txHash');
      const ts = event.timestamp || event.occurredAt || event.ledgerClosedAt;
      if (!ts) missing.push('timestamp');
      const items = event.items || event.legs;
      if (!Array.isArray(items) || items.length === 0) missing.push('items');

      logger.warn(
         buildLogFields({
            type: 'bundle_event_skipped',
            missing_fields: missing.length > 0 ? missing : REQUIRED_FIELDS,
            ledger: event.ledger,
            tx_hash: event.txHash || event.tx_hash,
         }),
         'Skipping bundle trade event with missing required fields'
      );
      return false;
   }

   const {
      wallet,
      ledger,
      txHash,
      timestamp,
      totalCost,
      itemCount,
      items,
      eventIndex,
   } = normalized;

   // 1. In-memory deduplication guard (if caller passes a seen Set)
   if (seen) {
      const guardResult = guardChainEvent(
         {
            txHash,
            eventIndex,
            ledger,
         } as ChainEvent,
         seen
      );
      if (guardResult.skipped) {
         logger.info(
            buildLogFields({
               type: 'bundle_event_duplicate_skipped',
               reason: 'in_memory_dedup',
               ledger,
               tx_hash: txHash,
            }),
            'Duplicate bundle trade event skipped by in-memory deduplication guard'
         );
         return false;
      }
   }

   // 2. Database deduplication guard (prevent duplicates on reindex)
   try {
      const existing = await db.bundleTrade.findFirst({
         where: {
            OR: [{ ledger, txHash }, { txHash }],
         },
         select: { id: true },
      });

      if (existing) {
         logger.info(
            buildLogFields({
               type: 'bundle_event_duplicate_skipped',
               reason: 'db_record_exists',
               ledger,
               tx_hash: txHash,
            }),
            'Duplicate bundle trade record already exists; skipping reindex'
         );
         return false;
      }
   } catch (_queryErr) {
      // In case findFirst is not mocked or errors, continue to atomic create attempt
   }

   // 3. Persist bundle header + items to bundle_trades table
   try {
      await db.bundleTrade.create({
         data: {
            wallet,
            buyer: wallet,
            totalCost,
            itemCount,
            items,
            ledger,
            txHash,
            timestamp,
         },
      });
   } catch (err: any) {
      // Catch unique constraint violations (e.g. Prisma P2002 or concurrent reindex race)
      if (
         err?.code === 'P2002' ||
         /unique|duplicate/i.test(err?.message || '')
      ) {
         logger.info(
            buildLogFields({
               type: 'bundle_event_duplicate_skipped',
               reason: 'unique_constraint',
               ledger,
               tx_hash: txHash,
            }),
            'Bundle trade duplicate rejected by database unique constraint'
         );
         return false;
      }
      throw err;
   }

   // 4. Cache invalidations for each creator key in the bundle (best-effort)
   for (const item of items) {
      try {
         const { invalidateCreatorDashboardCache } =
            await import('../creator/creator-dashboard.service');
         await invalidateCreatorDashboardCache(item.key);
      } catch {
         // Non-critical cache invalidation failure
      }
      try {
         const { invalidateKeyTwapCache } =
            await import('../keys/key-twap-window.service');
         await invalidateKeyTwapCache(item.key);
      } catch {
         // Non-critical cache invalidation failure
      }
      try {
         const { invalidateKeyAnalyticsCache } =
            await import('../keys/key-analytics.service');
         await invalidateKeyAnalyticsCache(item.key);
      } catch {
         // Non-critical cache invalidation failure
      }
   }

   return true;
}

/**
 * Processes a batch of BundleExecuted events with deduplication.
 */
export async function processBundleTradeEvents(
   events: Partial<BundleExecutedEvent>[],
   db: any = prisma
): Promise<{ processed: number; skipped: number }> {
   let processed = 0;
   let skipped = 0;
   const seen = new Set<string>();

   for (const event of events) {
      const eventType = event.eventType || event.event_type;
      if (
         eventType &&
         eventType !== 'BundleExecuted' &&
         eventType !== 'BUNDLE_EXECUTED'
      ) {
         continue;
      }

      const ok = await processBundleTradeEvent(event, db, seen);
      if (ok) {
         processed++;
      } else {
         skipped++;
      }
   }

   return { processed, skipped };
}
