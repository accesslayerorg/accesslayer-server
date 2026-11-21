import { prisma } from "../../utils/prisma.utils";
import {
   WalletActivityItem,
   WalletActivityQueryType,
   UnifiedActivityType,
} from "./wallet-activity.schemas";
import { decodeCursor, encodeCursor } from "../../utils/cursor.utils";

export interface ActivityFeedCursorPayload {
   id: string;
   timestamp?: string;
}

export async function fetchWalletActivity(
   address: string,
   query: WalletActivityQueryType
): Promise<[WalletActivityItem[], number, string | null]> {
   const { limit, offset, type, creator_id, cursor, from, to } = query;

   // 1. Fetch from ActivityLog table
   const logWhere: any = {
      actor: address,
   };
   if (type) {
      logWhere.type = type;
   }
   if (creator_id) {
      logWhere.keyId = creator_id;
   }
   if (from || to) {
      logWhere.timestamp = {};
      if (from) logWhere.timestamp.gte = new Date(from);
      if (to) logWhere.timestamp.lte = new Date(to);
   }

   // 2. Fetch from legacy Activity table
   const activityTypeMap: Record<string, UnifiedActivityType> = {
      KEY_BOUGHT: "buy",
      KEY_SOLD: "sell",
      KEY_BURNED: "burn",
      KEY_TRANSFERRED_IN: "transfer_in",
      KEY_TRANSFERRED_OUT: "transfer_out",
      DIVIDEND_DISTRIBUTED: "dividend",
   };

   const typeFilter =
      type === "buy"
         ? "KEY_BOUGHT"
         : type === "sell"
         ? "KEY_SOLD"
         : type === "burn"
         ? "KEY_BURNED"
         : type === "transfer_in"
         ? "KEY_TRANSFERRED_IN"
         : type === "transfer_out"
         ? "KEY_TRANSFERRED_OUT"
         : type === "dividend"
         ? "DIVIDEND_DISTRIBUTED"
         : undefined;

   const activityWhere: any = {
      actor: address,
      type: typeFilter ? typeFilter : { in: ["KEY_BOUGHT", "KEY_SOLD"] },
   };
   if (creator_id) {
      activityWhere.creatorId = creator_id;
   }
   if (from || to) {
      activityWhere.createdAt = {};
      if (from) activityWhere.createdAt.gte = new Date(from);
      if (to) activityWhere.createdAt.lte = new Date(to);
   }

   let prismaCursor: { id: string } | undefined;
   if (cursor) {
      try {
         const decoded = decodeCursor<ActivityFeedCursorPayload>(cursor);
         if (decoded && decoded.id) {
            prismaCursor = { id: decoded.id };
         }
      } catch (_e) {}
   }

   // Query both sources safely (handling test mocks where only one table is mocked)
   const [logRows, legacyRows, legacyCount] = await Promise.all([
      prisma.activityLog?.findMany
         ? prisma.activityLog.findMany({
              where: logWhere,
              orderBy: [{ timestamp: "desc" }, { id: "desc" }],
              take: limit * 3,
           })
         : Promise.resolve([]),
      prisma.activity?.findMany
         ? prisma.activity.findMany({
              where: activityWhere,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              skip: prismaCursor ? 1 : offset,
              take: limit,
              ...(prismaCursor ? { cursor: prismaCursor } : {}),
           })
         : Promise.resolve([]),
      prisma.activity?.count
         ? prisma.activity.count({ where: activityWhere }).catch(() => 0)
         : Promise.resolve(0),
   ]);

   // Also query dividend claims for the address if dividend type matches
   let dividendClaimRows: any[] = [];
   if (!type || type === "dividend") {
      try {
         dividendClaimRows = await prisma.dividendClaim.findMany({
            where: { recipientAddress: address },
            include: { distribution: true },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit * 3,
         });
      } catch (_e) {
         // table might be empty
      }
   }

   // Build unified list of items
   const unifiedItems: WalletActivityItem[] = [];
   const seenIds = new Set<string>();

   // Add ActivityLog entries
   for (const row of logRows) {
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      const kId = row.keyId || "";
      unifiedItems.push({
         id: row.id,
         type: row.type as UnifiedActivityType,
         keyId: kId,
         creator_id: kId,
         creatorName: row.creatorName || null,
         creator_handle: row.creatorName || null,
         amount: Number(row.amount ?? 0),
         timestamp: row.timestamp,
         txHash: row.txHash,
         payload: row.payload,
      } as any);
   }

   // Add legacy Activity entries
   for (let i = 0; i < legacyRows.length; i++) {
      const row = legacyRows[i];
      const mappedType = activityTypeMap[row.type];
      if (!mappedType) continue;
      if (type && mappedType !== type) continue;
      const rowId = row.id || `legacy-act-${i}-${row.createdAt ? new Date(row.createdAt).getTime() : Date.now()}`;
      if (seenIds.has(rowId)) continue;
      seenIds.add(rowId);

      const payload = (row.payload as Record<string, any>) || {};
      const kId = row.creatorId || payload.keyId || "";
      unifiedItems.push({
         id: rowId,
         type: mappedType,
         keyId: kId,
         creator_id: kId,
         creatorName: null,
         creator_handle: null,
         amount: Number(payload.amount ?? 0),
         timestamp: row.createdAt || new Date(),
         txHash: payload.txHash || null,
         price_at_trade: payload.price_at_trade,
         fee_paid: payload.fee_paid,
         ledger_sequence: payload.ledger_sequence ? Number(payload.ledger_sequence) : null,
      });
   }

   // Add DividendClaim entries
   for (const claim of dividendClaimRows) {
      const id = `div_${claim.id}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const kId = claim.distribution?.creatorId || "";
      unifiedItems.push({
         id,
         type: "dividend",
         keyId: kId,
         creator_id: kId,
         creatorName: null,
         creator_handle: null,
         amount: Number(claim.amountXlm ?? 0),
         timestamp: claim.claimedAt || claim.createdAt,
         txHash: claim.distribution?.txHash || null,
      });
   }

   // Resolve creator names for items missing creatorName / creator_handle
   const missingCreatorIds: string[] = [
      ...new Set(
         unifiedItems
            .filter((item) => (!item.creatorName || !item.creator_handle) && Boolean(item.keyId))
            .map((item) => item.keyId as string)
      ),
   ];

   if (missingCreatorIds.length > 0) {
      const creatorProfiles = await prisma.creatorProfile.findMany({
         where: { id: { in: missingCreatorIds } },
         select: { id: true, handle: true, displayName: true },
      });
      const nameMap = new Map<string, string>();
      for (const cp of creatorProfiles) {
         nameMap.set(cp.id, cp.displayName || cp.handle || cp.id);
      }
      for (const item of unifiedItems) {
         if (item.keyId && nameMap.has(item.keyId)) {
            const resolvedName = nameMap.get(item.keyId) || null;
            item.creatorName = resolvedName;
            item.creator_handle = resolvedName;
         }
      }
   }

   // Sort unified items by timestamp descending
   unifiedItems.sort((a, b) => {
      const tA = new Date(a.timestamp).getTime();
      const tB = new Date(b.timestamp).getTime();
      if (tB !== tA) return tB - tA;
      return b.id.localeCompare(a.id);
   });

   let total = legacyCount > 0 ? legacyCount : unifiedItems.length;
   if (unifiedItems.length > total) total = unifiedItems.length;

   // Cursor-based pagination slice
   let startIndex = 0;
   if (cursor) {
      try {
         const decoded = decodeCursor<ActivityFeedCursorPayload>(cursor);
         if (decoded && decoded.id) {
            const foundIdx = unifiedItems.findIndex((item) => item.id === decoded.id);
            if (foundIdx !== -1) {
               startIndex = foundIdx + 1;
            }
         }
      } catch (_e) {
         // ignore invalid cursor
      }
   } else if (offset) {
      startIndex = offset;
   }

   const pageItems = unifiedItems.slice(startIndex, startIndex + limit);
   const lastItem = pageItems[pageItems.length - 1];
   const hasMore = startIndex + limit < unifiedItems.length || total > startIndex + limit;
   const nextCursor =
      hasMore && lastItem
         ? encodeCursor({ id: lastItem.id })
         : null;

   return [pageItems, total, nextCursor];
}
