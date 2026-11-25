import { prisma } from '../../utils/prisma.utils';
import { decodeCursor, encodeCursor } from '../../utils/cursor.utils';

export type PassEventStatus = 'upcoming' | 'open' | 'full' | 'ended' | 'closed';

export type EligibilityFailureReason =
   | 'event_closed'
   | 'outside_window'
   | 'capacity_full'
   | 'already_redeemed'
   | 'insufficient_balance';

export class PassEventNotFoundError extends Error {
   constructor(eventId: string) {
      super(`Pass event ${eventId} not found`);
      this.name = 'PassEventNotFoundError';
   }
}

export class PassEventForbiddenError extends Error {
   constructor() {
      super('Only the event creator can view redemptions');
      this.name = 'PassEventForbiddenError';
   }
}

export function computePassEventStatus(
   event: {
      closed: boolean;
      startLedger: number;
      endLedger: number;
      capacity: number;
      redeemedCount: number;
   },
   currentLedger: number
): PassEventStatus {
   if (event.closed) {
      return 'closed';
   }
   if (currentLedger < event.startLedger) {
      return 'upcoming';
   }
   if (currentLedger > event.endLedger) {
      return 'ended';
   }
   if (event.redeemedCount >= event.capacity) {
      return 'full';
   }
   return 'open';
}

async function getCurrentLedger(): Promise<number> {
   const row = await prisma.indexedLedger.findUnique({
      where: { id: 1 },
      select: { ledger: true },
   });
   return row?.ledger ?? 0;
}

interface RedemptionCursorPayload {
   ledger: number;
   id: string;
}

export class PassEventsService {
   static async listKeyEvents(keyId: string) {
      const [events, currentLedger] = await Promise.all([
         prisma.passEvent.findMany({
            where: { keyId },
            orderBy: { startLedger: 'asc' },
         }),
         getCurrentLedger(),
      ]);

      return {
         keyId,
         currentLedger,
         events: events.map(event => ({
            id: event.id,
            keyId: event.keyId,
            title: event.title,
            window: {
               startLedger: event.startLedger,
               endLedger: event.endLedger,
            },
            capacity: event.capacity,
            redeemedCount: event.redeemedCount,
            remainingCapacity: Math.max(0, event.capacity - event.redeemedCount),
            minBalance: String(event.minBalance),
            status: computePassEventStatus(event, currentLedger),
         })),
      };
   }

   static async checkEligibility(eventId: string, wallet: string) {
      const event = await prisma.passEvent.findUnique({
         where: { id: eventId },
      });
      if (!event) {
         throw new PassEventNotFoundError(eventId);
      }

      const [currentLedger, ownership, redemption] = await Promise.all([
         getCurrentLedger(),
         prisma.keyOwnership.findUnique({
            where: {
               ownerAddress_creatorId: {
                  ownerAddress: wallet,
                  creatorId: event.keyId,
               },
            },
            select: { balance: true },
         }),
         prisma.passRedemption.findUnique({
            where: {
               eventId_wallet: { eventId, wallet },
            },
            select: { id: true },
         }),
      ]);

      const status = computePassEventStatus(event, currentLedger);
      const balance = ownership ? Number(ownership.balance) : 0;
      const minBalance = Number(event.minBalance);

      const notClosed = !event.closed;
      const insideWindow =
         currentLedger >= event.startLedger && currentLedger <= event.endLedger;
      const hasCapacity = event.redeemedCount < event.capacity;
      const notRedeemed = !redemption;
      const meetsMinBalance = balance >= minBalance;

      const reasons: EligibilityFailureReason[] = [];
      if (!notClosed) reasons.push('event_closed');
      if (!insideWindow) reasons.push('outside_window');
      if (!hasCapacity) reasons.push('capacity_full');
      if (!notRedeemed) reasons.push('already_redeemed');
      if (!meetsMinBalance) reasons.push('insufficient_balance');

      return {
         eventId,
         wallet,
         eligible: reasons.length === 0,
         status,
         reasons,
         checks: {
            notClosed,
            insideWindow,
            hasCapacity,
            notRedeemed,
            meetsMinBalance,
         },
      };
   }

   static async listRedemptions(
      eventId: string,
      requesterWallet: string,
      cursor?: string,
      limit: number = 20
   ) {
      const event = await prisma.passEvent.findUnique({
         where: { id: eventId },
      });
      if (!event) {
         throw new PassEventNotFoundError(eventId);
      }
      if (event.creatorWallet !== requesterWallet) {
         throw new PassEventForbiddenError();
      }

      let cursorWhere: Record<string, unknown> = {};
      if (cursor) {
         const decoded = decodeCursor<RedemptionCursorPayload>(cursor);
         cursorWhere = {
            OR: [
               { ledger: { lt: decoded.ledger } },
               { ledger: decoded.ledger, id: { lt: decoded.id } },
            ],
         };
      }

      const rows = await prisma.passRedemption.findMany({
         where: {
            eventId,
            ...cursorWhere,
         },
         orderBy: [{ ledger: 'desc' }, { id: 'desc' }],
         take: limit + 1,
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor =
         hasMore && items.length > 0
            ? encodeCursor<RedemptionCursorPayload>({
                 ledger: items[items.length - 1].ledger,
                 id: items[items.length - 1].id,
              })
            : null;

      return {
         eventId,
         redemptions: items,
         cursor: nextCursor,
      };
   }
}
