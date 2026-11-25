import { prisma } from '../../utils/prisma.utils';
import { decodeCursor, encodeCursor } from '../../utils/cursor.utils';
import { logger } from '../../utils/logger.utils';
import { decryptNoteBody, encryptNoteBody } from './trade-notes.crypto';
import {
   OutcomeService,
   OutcomeTradeInput,
   TradeOutcome,
} from './outcome.service';
import { ListTradeNotesQuery, UpsertTradeNoteInput } from './trade-notes.schemas';

export class TradeNotFoundError extends Error {
   constructor(txHash: string) {
      super(`Trade ${txHash} not found`);
      this.name = 'TradeNotFoundError';
   }
}

export class TradeOwnershipError extends Error {
   constructor(txHash: string) {
      super(`Wallet does not own trade ${txHash}`);
      this.name = 'TradeOwnershipError';
   }
}

interface TradeNoteCursor {
   id: string;
   updatedAt: string;
}

export interface TradeNoteView {
   id: string;
   wallet: string;
   txHash: string;
   keyId: string | null;
   body: string;
   tags: string[];
   createdAt: Date;
   updatedAt: Date;
   outcome: TradeOutcome | null;
}

export interface PaginatedTradeNotes {
   items: TradeNoteView[];
   nextCursor: string | null;
   hasMore: boolean;
}

function extractFeeFromPayload(payload: unknown): number {
   if (!payload || typeof payload !== 'object') return 0;
   const obj = payload as Record<string, unknown>;
   const raw = obj.fee ?? obj.fees ?? obj.protocolFee ?? 0;
   const num = Number(raw);
   return Number.isFinite(num) ? num : 0;
}

function extractQuantityFromPayload(payload: unknown, fallback = 1): number {
   if (!payload || typeof payload !== 'object') return fallback;
   const obj = payload as Record<string, unknown>;
   const raw = obj.quantity ?? obj.amount ?? fallback;
   const num = Number(raw);
   return Number.isFinite(num) && num > 0 ? num : fallback;
}

function extractPriceFromPayload(payload: unknown, amount: unknown): number {
   if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      if (obj.price !== undefined) {
         const p = Number(obj.price);
         if (Number.isFinite(p)) return p;
      }
   }
   const qty = extractQuantityFromPayload(payload, 1);
   const total = Number(amount ?? 0);
   if (Number.isFinite(total) && qty > 0) {
      return total / qty;
   }
   return 0;
}

/**
 * Resolves a trade by `txHash` and verifies it belongs to `wallet`.
 * Checks `Trade` (buys) and `ActivityLog` (buys/sells).
 */
export async function verifyAndResolveOwnedTrade(
   wallet: string,
   txHash: string
): Promise<OutcomeTradeInput> {
   const buyTrade = await prisma.trade.findFirst({
      where: { txHash, buyer: wallet },
      select: {
         creatorId: true,
         quantity: true,
         price: true,
      },
   });

   if (buyTrade) {
      return {
         side: 'buy',
         keyId: buyTrade.creatorId,
         quantity: buyTrade.quantity,
         price: buyTrade.price,
         fees: 0,
      };
   }

   const activityTrade = await prisma.activityLog.findFirst({
      where: {
         txHash,
         actor: wallet,
         type: { in: ['buy', 'sell'] },
      },
      select: {
         type: true,
         keyId: true,
         amount: true,
         payload: true,
      },
   });

   if (activityTrade && activityTrade.keyId) {
      const quantity = extractQuantityFromPayload(activityTrade.payload, 1);
      const price = extractPriceFromPayload(
         activityTrade.payload,
         activityTrade.amount
      );
      const fees = extractFeeFromPayload(activityTrade.payload);
      return {
         side: activityTrade.type === 'sell' ? 'sell' : 'buy',
         keyId: activityTrade.keyId,
         quantity,
         price,
         fees,
      };
   }

   // Check whether the txHash exists for a different wallet so we can return 403 vs 404.
   const [otherBuy, otherActivity] = await Promise.all([
      prisma.trade.findFirst({ where: { txHash }, select: { id: true } }),
      prisma.activityLog.findFirst({
         where: { txHash, type: { in: ['buy', 'sell'] } },
         select: { id: true },
      }),
   ]);

   if (otherBuy || otherActivity) {
      throw new TradeOwnershipError(txHash);
   }

   throw new TradeNotFoundError(txHash);
}

async function resolveOutcomeForTx(
   wallet: string,
   txHash: string
): Promise<TradeOutcome | null> {
   try {
      const trade = await verifyAndResolveOwnedTrade(wallet, txHash);
      return await OutcomeService.compute(trade);
   } catch {
      return null;
   }
}

export async function upsertTradeNote(
   wallet: string,
   txHash: string,
   input: UpsertTradeNoteInput
): Promise<TradeNoteView> {
   const ownedTrade = await verifyAndResolveOwnedTrade(wallet, txHash);

   const normalizedTags = Array.from(new Set(input.tags));
   const encryptedBody = encryptNoteBody(input.body);

   const saved = await prisma.tradeNote.upsert({
      where: {
         wallet_txHash: { wallet, txHash },
      },
      create: {
         wallet,
         txHash,
         keyId: ownedTrade.keyId,
         body: encryptedBody,
         tags: normalizedTags,
      },
      update: {
         keyId: ownedTrade.keyId,
         body: encryptedBody,
         tags: normalizedTags,
      },
   });

   // Privacy: never log note body or plaintext tags content beyond counts.
   logger.info(
      {
         type: 'trade_note_upserted',
         wallet,
         txHash,
         keyId: ownedTrade.keyId,
         tagCount: normalizedTags.length,
      },
      'Trade note saved'
   );

   const outcome = await OutcomeService.compute(ownedTrade);

   return {
      id: saved.id,
      wallet: saved.wallet,
      txHash: saved.txHash,
      keyId: saved.keyId,
      body: input.body,
      tags: saved.tags,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
      outcome,
   };
}

export async function listTradeNotes(
   wallet: string,
   query: ListTradeNotesQuery
): Promise<PaginatedTradeNotes> {
   const limit = query.limit ?? 20;
   let decodedCursor: TradeNoteCursor | null = null;
   if (query.cursor) {
      decodedCursor = decodeCursor<TradeNoteCursor>(query.cursor);
   }

   const where: Record<string, unknown> = { wallet };
   if (query.tag) {
      where.tags = { has: query.tag };
   }
   if (query.keyId) {
      where.keyId = query.keyId;
   }
   if (decodedCursor) {
      const cursorDate = new Date(decodedCursor.updatedAt);
      where.OR = [
         { updatedAt: { lt: cursorDate } },
         { updatedAt: cursorDate, id: { lt: decodedCursor.id } },
      ];
   }

   const rows = await prisma.tradeNote.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
   });

   const hasMore = rows.length > limit;
   const pageRows = hasMore ? rows.slice(0, limit) : rows;

   const items: TradeNoteView[] = await Promise.all(
      pageRows.map(async row => {
         const plaintextBody = decryptNoteBody(row.body);
         const outcome = await resolveOutcomeForTx(wallet, row.txHash);
         return {
            id: row.id,
            wallet: row.wallet,
            txHash: row.txHash,
            keyId: row.keyId,
            body: plaintextBody,
            tags: row.tags,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            outcome,
         };
      })
   );

   const lastRow = pageRows[pageRows.length - 1];
   const nextCursor =
      hasMore && lastRow
         ? encodeCursor<TradeNoteCursor>({
              id: lastRow.id,
              updatedAt: lastRow.updatedAt.toISOString(),
           })
         : null;

   return {
      items,
      nextCursor,
      hasMore,
   };
}
