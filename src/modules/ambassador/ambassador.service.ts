import { prisma } from '../../utils/prisma.utils';
import { decodeCursor, encodeCursor } from '../../utils/cursor.utils';
import {
   AmbassadorPayoutsQuery,
   AmbassadorStatsRange,
   RecordClickInput,
} from './ambassador.schemas';

export const ATTRIBUTION_WINDOW_DAYS = 30;
const ATTRIBUTION_WINDOW_MS = ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface AmbassadorTierDefinition {
   tier: number;
   minActiveTraders: number;
   share: number;
}

export const AMBASSADOR_TIERS: readonly AmbassadorTierDefinition[] = [
   { tier: 1, minActiveTraders: 0, share: 0.1 },
   { tier: 2, minActiveTraders: 5, share: 0.15 },
   { tier: 3, minActiveTraders: 20, share: 0.2 },
   { tier: 4, minActiveTraders: 50, share: 0.25 },
];

export class ReferralCodeNotFoundError extends Error {
   constructor(code: string) {
      super(`Referral code ${code} not found`);
      this.name = 'ReferralCodeNotFoundError';
   }
}

export interface AmbassadorStats {
   wallet: string;
   range: AmbassadorStatsRange;
   clicks: number;
   signUps: number;
   firstTrades: number;
   repeatTraders: number;
   volume: number;
   activeTraders: number;
   tier: number;
   tierShare: number;
   accruedEarnings: number;
}

export interface DailyTradeFeeItem {
   traderWallet: string;
   fee: number;
   volume: number;
}

interface PayoutCursor {
   id: string;
   payoutDate: string;
}

function getRangeStart(range: AmbassadorStatsRange, now = new Date()): Date | null {
   if (range === 'all') return null;
   const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
   return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function round7(value: number): number {
   return Math.round(value * 10_000_000) / 10_000_000;
}

function toUtcDateOnly(date: Date): Date {
   return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
   );
}

export class AmbassadorService {
   /**
    * Resolves the ambassador tier and fee share from active trader count.
    */
   static computeTier(activeTraders: number): AmbassadorTierDefinition {
      let current = AMBASSADOR_TIERS[0];
      for (const tier of AMBASSADOR_TIERS) {
         if (activeTraders >= tier.minActiveTraders) {
            current = tier;
         }
      }
      return current;
   }

   /**
    * Records a referral link click with UTM metadata and first-party cookie id.
    */
   static async recordClick(input: RecordClickInput) {
      const codeRecord = await prisma.referralCode.findUnique({
         where: { code: input.referralCode },
         select: { walletAddress: true, code: true },
      });

      if (!codeRecord) {
         throw new ReferralCodeNotFoundError(input.referralCode);
      }

      return prisma.referralClick.create({
         data: {
            referrerWallet: codeRecord.walletAddress,
            referralCode: codeRecord.code,
            cookieId: input.cookieId,
            utmSource: input.utmSource,
            utmMedium: input.utmMedium,
            utmCampaign: input.utmCampaign,
            utmTerm: input.utmTerm,
            utmContent: input.utmContent,
         },
      });
   }

   /**
    * Attributes a wallet on its first connection to the last valid referral
    * click within the 30-day attribution window. Self-referrals are ignored.
    */
   static async attributeOnFirstConnection(
      wallet: string,
      cookieId: string,
      now: Date = new Date()
   ) {
      const existing = await prisma.referralAttribution.findUnique({
         where: { refereeWallet: wallet },
      });
      if (existing) {
         return existing;
      }

      const windowStart = new Date(now.getTime() - ATTRIBUTION_WINDOW_MS);

      const lastValidClick = await prisma.referralClick.findFirst({
         where: {
            cookieId,
            referrerWallet: { not: wallet },
            clickedAt: {
               gte: windowStart,
               lte: now,
            },
         },
         orderBy: [{ clickedAt: 'desc' }, { id: 'desc' }],
      });

      if (!lastValidClick) {
         return null;
      }

      // Check if an abuse hold already exists for this pair.
      const held = await prisma.referralHold.findFirst({
         where: {
            referrerAddress: lastValidClick.referrerWallet,
            refereeAddress: wallet,
            status: { in: ['PENDING', 'REJECTED'] },
         },
         select: { id: true },
      });

      return prisma.referralAttribution.create({
         data: {
            refereeWallet: wallet,
            referrerWallet: lastValidClick.referrerWallet,
            clickId: lastValidClick.id,
            cookieId,
            referralCode: lastValidClick.referralCode,
            attributedAt: now,
            isHeld: Boolean(held),
         },
      });
   }

   /**
    * Returns consistent funnel stats and accrued earnings for an ambassador.
    */
   static async stats(
      wallet: string,
      range: AmbassadorStatsRange = '30d',
      now: Date = new Date()
   ): Promise<AmbassadorStats> {
      const rangeStart = getRangeStart(range, now);
      const clickWhere: Record<string, unknown> = { referrerWallet: wallet };
      const attrWhere: Record<string, unknown> = {
         referrerWallet: wallet,
         refereeWallet: { not: wallet },
         isHeld: false,
      };

      if (rangeStart) {
         clickWhere.clickedAt = { gte: rangeStart, lte: now };
         attrWhere.attributedAt = { gte: rangeStart, lte: now };
      }

      const [clicks, attributions, payouts] = await Promise.all([
         prisma.referralClick.count({ where: clickWhere }),
         prisma.referralAttribution.findMany({
            where: attrWhere,
            select: {
               firstTradeAt: true,
               tradeCount: true,
               totalVolume: true,
            },
         }),
         prisma.ambassadorPayout.findMany({
            where: {
               ambassadorWallet: wallet,
               ...(rangeStart ? { payoutDate: { gte: toUtcDateOnly(rangeStart) } } : {}),
            },
            select: { accruedAmount: true },
         }),
      ]);

      const signUps = attributions.length;
      let firstTrades = 0;
      let repeatTraders = 0;
      let volume = 0;

      for (const attr of attributions) {
         if (attr.firstTradeAt !== null) {
            firstTrades += 1;
         }
         if (attr.tradeCount >= 2) {
            repeatTraders += 1;
         }
         volume += Number(attr.totalVolume ?? 0);
      }

      // Active traders across all non-held attributions determine current tier.
      const activeTraders = await prisma.referralAttribution.count({
         where: {
            referrerWallet: wallet,
            refereeWallet: { not: wallet },
            isHeld: false,
            firstTradeAt: { not: null },
         },
      });

      const tierDef = AmbassadorService.computeTier(activeTraders);
      const accruedEarnings = payouts.reduce(
         (sum, p) => sum + Number(p.accruedAmount ?? 0),
         0
      );

      return {
         wallet,
         range,
         clicks,
         signUps,
         firstTrades,
         repeatTraders,
         volume: round7(volume),
         activeTraders,
         tier: tierDef.tier,
         tierShare: tierDef.share,
         accruedEarnings: round7(accruedEarnings),
      };
   }

   /**
    * Accrues daily earnings for an ambassador from referred trade fees.
    * Self-referrals and held referrals are strictly excluded.
    * Tier is computed from active traders on that day so threshold changes apply
    * immediately from the day they are met.
    */
   static async accrueDailyPayout(
      ambassadorWallet: string,
      date: Date,
      trades: DailyTradeFeeItem[]
   ) {
      const payoutDate = toUtcDateOnly(date);
      const endOfDay = new Date(payoutDate.getTime() + 24 * 60 * 60 * 1000 - 1);

      const [attributions, holds] = await Promise.all([
         prisma.referralAttribution.findMany({
            where: {
               referrerWallet: ambassadorWallet,
               refereeWallet: { not: ambassadorWallet },
               isHeld: false,
               attributedAt: { lte: endOfDay },
            },
            select: {
               refereeWallet: true,
               firstTradeAt: true,
            },
         }),
         prisma.referralHold.findMany({
            where: {
               referrerAddress: ambassadorWallet,
               status: { in: ['PENDING', 'REJECTED'] },
            },
            select: { refereeAddress: true },
         }),
      ]);

      const heldWallets = new Set(holds.map(h => h.refereeAddress));
      const eligibleTraders = new Set<string>();
      let activeTradersOnDay = 0;

      for (const attr of attributions) {
         if (heldWallets.has(attr.refereeWallet)) continue;
         eligibleTraders.add(attr.refereeWallet);
         if (attr.firstTradeAt && attr.firstTradeAt <= endOfDay) {
            activeTradersOnDay += 1;
         }
      }

      // Also count traders who made their first trade on this exact day.
      const tradedToday = new Set<string>();
      let totalFees = 0;

      for (const trade of trades) {
         if (trade.traderWallet === ambassadorWallet) continue;
         if (!eligibleTraders.has(trade.traderWallet)) continue;
         if (heldWallets.has(trade.traderWallet)) continue;
         if (trade.fee > 0) {
            totalFees += trade.fee;
         }
         tradedToday.add(trade.traderWallet);
      }

      for (const attr of attributions) {
         if (
            !heldWallets.has(attr.refereeWallet) &&
            !attr.firstTradeAt &&
            tradedToday.has(attr.refereeWallet)
         ) {
            activeTradersOnDay += 1;
         }
      }

      const tierDef = AmbassadorService.computeTier(activeTradersOnDay);
      const roundedFees = round7(totalFees);
      const accruedAmount = round7(roundedFees * tierDef.share);

      return prisma.ambassadorPayout.upsert({
         where: {
            ambassadorWallet_payoutDate: {
               ambassadorWallet,
               payoutDate,
            },
         },
         create: {
            ambassadorWallet,
            payoutDate,
            tier: tierDef.tier,
            tierShare: tierDef.share,
            activeTraders: activeTradersOnDay,
            totalFees: roundedFees,
            accruedAmount,
            status: 'accrued',
         },
         update: {
            tier: tierDef.tier,
            tierShare: tierDef.share,
            activeTraders: activeTradersOnDay,
            totalFees: roundedFees,
            accruedAmount,
         },
      });
   }

   /**
    * Lists daily ambassador payout accruals with stable cursor pagination.
    */
   static async listPayouts(
      wallet: string,
      query: AmbassadorPayoutsQuery
   ) {
      const limit = query.limit ?? 20;
      let decoded: PayoutCursor | null = null;
      if (query.cursor) {
         decoded = decodeCursor<PayoutCursor>(query.cursor);
      }

      const where: Record<string, unknown> = {
         ambassadorWallet: wallet,
      };
      if (decoded) {
         const cursorDate = new Date(decoded.payoutDate);
         where.OR = [
            { payoutDate: { lt: cursorDate } },
            { payoutDate: cursorDate, id: { lt: decoded.id } },
         ];
      }

      const rows = await prisma.ambassadorPayout.findMany({
         where,
         orderBy: [{ payoutDate: 'desc' }, { id: 'desc' }],
         take: limit + 1,
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items[items.length - 1];
      const nextCursor =
         hasMore && last
            ? encodeCursor<PayoutCursor>({
                 id: last.id,
                 payoutDate: last.payoutDate.toISOString(),
              })
            : null;

      return { items, nextCursor, hasMore };
   }
}
