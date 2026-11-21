// Unit tests: referral tracking and reward distribution (#1198)
//
// Covers the acceptance criteria:
//   - referral registration stores the relationship correctly
//   - earnings endpoint returns accurate totals and a per-referral breakdown
//   - referred wallets list shows join date and first-trade status
//   - referral fee is recorded on every referred trade with tier multiplier
//   - duplicate referral registration for the same wallet is rejected

jest.mock('../../utils/prisma.utils', () => {
   const referral = {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
   };
   const referralEvent = {
      create: jest.fn(),
      aggregate: jest.fn(),
      groupBy: jest.fn(),
   };
   const referralHold = {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
   };
   const referralHoldReward = { create: jest.fn() };
   const prisma = {
      referralCode: { findUnique: jest.fn(), create: jest.fn() },
      referral,
      referralEvent,
      referralHold,
      referralHoldReward,
      protocolConfig: {
         upsert: jest.fn().mockResolvedValue({ protocolFeeBps: 500 }),
      },
      $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
         callback({ referral, referralEvent, referralHold, referralHoldReward })
      ),
   };

   return { prisma };
});

// Abuse detection and funding lookups are covered by their own unit tests;
// here they are stubbed so these tests stay about referral bookkeeping (#1241).
jest.mock('../../services/referral-abuse.service', () => ({
   ReferralAbuseService: { evaluate: jest.fn() },
}));
jest.mock('../../services/wallet-funding.service', () => ({
   prefetchFundingSource: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../utils/prisma.utils';
import { ReferralAbuseService } from '../../services/referral-abuse.service';
import { prefetchFundingSource } from '../../services/wallet-funding.service';
import { encodeCursor } from '../../utils/cursor.utils';
import {
   AlreadyReferredError,
   generateReferralCode,
   getOrCreateReferralCode,
   getReferralEarnings,
   getReferralStats,
   listReferredWallets,
   recordTradeReferralReward,
   ReferralCodeNotFoundError,
   registerReferral,
   SelfReferralError,
} from './referrals.service';
import { REFERRAL_CODE_ALPHABET, REFERRAL_CODE_LENGTH } from './referrals.constants';

const codeFindUnique = prisma.referralCode.findUnique as jest.Mock;
const codeCreate = prisma.referralCode.create as jest.Mock;
const referralFindUnique = prisma.referral.findUnique as jest.Mock;
const referralFindMany = prisma.referral.findMany as jest.Mock;
const referralCreate = prisma.referral.create as jest.Mock;
const referralCount = prisma.referral.count as jest.Mock;
const referralUpdateMany = prisma.referral.updateMany as jest.Mock;
const eventCreate = prisma.referralEvent.create as jest.Mock;
const eventAggregate = prisma.referralEvent.aggregate as jest.Mock;
const eventGroupBy = prisma.referralEvent.groupBy as jest.Mock;
const protocolConfigUpsert = prisma.protocolConfig.upsert as jest.Mock;
const holdFindUnique = prisma.referralHold.findUnique as jest.Mock;
const holdUpsert = prisma.referralHold.upsert as jest.Mock;
const holdUpdateMany = prisma.referralHold.updateMany as jest.Mock;
const holdRewardCreate = prisma.referralHoldReward.create as jest.Mock;
const abuseEvaluate = ReferralAbuseService.evaluate as jest.Mock;

const REFERRER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const REFEREE = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const REFEREE_2 = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const CODE = 'ABCD2345EF';

function referralRow(overrides: Record<string, unknown> = {}) {
   return {
      id: 'ref-1',
      referrerAddress: REFERRER,
      refereeAddress: REFEREE,
      referralCode: CODE,
      firstTradeAt: null,
      firstTradeKeyId: null,
      createdAt: new Date('2026-09-01T10:00:00.000Z'),
      updatedAt: new Date('2026-09-01T10:00:00.000Z'),
      ...overrides,
   };
}

/** Prisma P2002 (unique constraint violation) shape. */
function uniqueViolation(target: string) {
   return Object.assign(new Error(`Unique constraint failed on ${target}`), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      meta: { target: [target] },
   });
}

describe('referral code generation', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('generates codes of the configured length from the unambiguous alphabet', () => {
      for (let i = 0; i < 50; i += 1) {
         const code = generateReferralCode();
         expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
         for (const char of code) {
            expect(REFERRAL_CODE_ALPHABET).toContain(char);
         }
         // Ambiguous characters must never appear.
         expect(code).not.toMatch(/[01IO]/);
      }
   });

   it('generates different codes for different wallets', () => {
      const codes = new Set(
         Array.from({ length: 100 }, () => generateReferralCode())
      );
      expect(codes.size).toBeGreaterThan(90);
   });

   describe('getOrCreateReferralCode', () => {
      it('stores a generated code for a wallet that has none', async () => {
         codeFindUnique.mockResolvedValue(null);
         codeCreate.mockImplementation(async ({ data }: any) => ({
            code: data.code,
         }));

         const code = await getOrCreateReferralCode(REFERRER);

         expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
         expect(codeCreate).toHaveBeenCalledWith(
            expect.objectContaining({
               data: { walletAddress: REFERRER, code },
            })
         );
      });

      it('returns the existing code without writing a new one', async () => {
         codeFindUnique.mockResolvedValue({ code: CODE });

         await expect(getOrCreateReferralCode(REFERRER)).resolves.toBe(CODE);
         expect(codeCreate).not.toHaveBeenCalled();
      });

      it('re-reads the code when a concurrent request created it first', async () => {
         codeFindUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ code: CODE });
         codeCreate.mockRejectedValue(uniqueViolation('code'));

         await expect(getOrCreateReferralCode(REFERRER)).resolves.toBe(CODE);
      });

      it('gives up after exhausting the collision retry budget', async () => {
         codeFindUnique.mockResolvedValue(null);
         codeCreate.mockRejectedValue(uniqueViolation('code'));

         await expect(getOrCreateReferralCode(REFERRER)).rejects.toThrow(
            /Unable to generate a unique referral code/
         );
         expect(codeCreate).toHaveBeenCalledTimes(5);
      });
   });
});

describe('registerReferral', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('stores the relationship between the referee and the code owner', async () => {
      codeFindUnique.mockResolvedValue({ walletAddress: REFERRER });
      referralFindUnique.mockResolvedValue(null);
      referralCreate.mockResolvedValue(referralRow({ id: 'ref-42' }));

      const result = await registerReferral(REFEREE, CODE);

      expect(referralCreate).toHaveBeenCalledWith({
         data: {
            referrerAddress: REFERRER,
            refereeAddress: REFEREE,
            referralCode: CODE,
         },
      });
      expect(result).toEqual({
         referralId: 'ref-42',
         referrerAddress: REFERRER,
         refereeAddress: REFEREE,
         referralCode: CODE,
         joinedAt: '2026-09-01T10:00:00.000Z',
         status: 'PENDING',
      });
   });

   it("resolves the referee's funding source at registration so clusters are visible early (#1241)", async () => {
      codeFindUnique.mockResolvedValue({ walletAddress: REFERRER });
      referralFindUnique.mockResolvedValue(null);
      referralCreate.mockResolvedValue(referralRow());

      await registerReferral(REFEREE, CODE);

      expect(prefetchFundingSource).toHaveBeenCalledWith(REFEREE);
   });

   it('normalises the submitted code so it matches the stored casing', async () => {
      codeFindUnique.mockResolvedValue({ walletAddress: REFERRER });
      referralFindUnique.mockResolvedValue(null);
      referralCreate.mockResolvedValue(referralRow());

      await registerReferral(REFEREE, `  ${CODE.toLowerCase()}  `);

      expect(codeFindUnique).toHaveBeenCalledWith({
         where: { code: CODE },
         select: { walletAddress: true },
      });
   });

   it('rejects a duplicate registration for the same wallet', async () => {
      codeFindUnique.mockResolvedValue({ walletAddress: REFERRER });
      referralFindUnique.mockResolvedValue({
         referrerAddress: 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
      });

      await expect(registerReferral(REFEREE, CODE)).rejects.toBeInstanceOf(
         AlreadyReferredError
      );
      expect(referralCreate).not.toHaveBeenCalled();
   });

   it('rejects a duplicate registration that races past the pre-check', async () => {
      codeFindUnique.mockResolvedValue({ walletAddress: REFERRER });
      referralFindUnique.mockResolvedValue(null);
      referralCreate.mockRejectedValue(uniqueViolation('refereeAddress'));

      await expect(registerReferral(REFEREE, CODE)).rejects.toBeInstanceOf(
         AlreadyReferredError
      );
   });

   it('rejects an unknown referral code', async () => {
      codeFindUnique.mockResolvedValue(null);

      await expect(registerReferral(REFEREE, 'NOPE1234XX')).rejects.toBeInstanceOf(
         ReferralCodeNotFoundError
      );
      expect(referralCreate).not.toHaveBeenCalled();
   });

   it('rejects a wallet registering with its own code', async () => {
      codeFindUnique.mockResolvedValue({ walletAddress: REFEREE });

      await expect(registerReferral(REFEREE, CODE)).rejects.toBeInstanceOf(
         SelfReferralError
      );
      expect(referralCreate).not.toHaveBeenCalled();
   });
});

describe('getReferralEarnings', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      codeFindUnique.mockResolvedValue({ code: CODE });
      eventGroupBy.mockResolvedValue([]);
   });

   function mockCounts(referredCount: number, rewardedCount: number) {
      referralCount.mockImplementation(async ({ where }: any) =>
         where.firstTradeAt ? rewardedCount : referredCount
      );
   }

   it('returns zeros and an empty breakdown for a wallet with no referrals', async () => {
      eventAggregate.mockResolvedValue({ _sum: { amount: null } });
      referralFindMany.mockResolvedValue([]);
      mockCounts(0, 0);

      const result = await getReferralEarnings(REFERRER, { limit: 20 });

      expect(result).toEqual({
         referralCode: CODE,
         totalEarned: 0,
         rewardedReferralCount: 0,
         referredCount: 0,
         breakdown: [],
         pagination: { limit: 20, nextCursor: null, hasMore: false },
      });
   });

   it('returns the total earned and a per-referral breakdown', async () => {
      const firstTradeAt = new Date('2026-09-05T12:00:00.000Z');
      eventAggregate.mockResolvedValue({ _sum: { amount: '12.5' } });
      referralFindMany.mockResolvedValue([
         referralRow({
            id: 'ref-1',
            refereeAddress: REFEREE,
            firstTradeAt,
            firstTradeKeyId: 'key-1',
         }),
         referralRow({
            id: 'ref-2',
            refereeAddress: REFEREE_2,
            firstTradeAt: null,
         }),
      ]);
      eventGroupBy.mockResolvedValue([
         { refereeAddress: REFEREE, _sum: { amount: '10' } },
         { refereeAddress: REFEREE_2, _sum: { amount: null } },
      ]);
      mockCounts(2, 1);

      const result = await getReferralEarnings(REFERRER, { limit: 20 });

      expect(result.totalEarned).toBe(12.5);
      expect(result.referredCount).toBe(2);
      expect(result.rewardedReferralCount).toBe(1);
      expect(result.breakdown).toEqual([
         {
            refereeAddress: REFEREE,
            joinedAt: '2026-09-01T10:00:00.000Z',
            firstTradeAt: '2026-09-05T12:00:00.000Z',
            status: 'ACTIVE',
            earnedXlm: 10,
         },
         {
            refereeAddress: REFEREE_2,
            joinedAt: '2026-09-01T10:00:00.000Z',
            firstTradeAt: null,
            status: 'PENDING',
            earnedXlm: 0,
         },
      ]);
   });

   it('creates and returns a referral code for a wallet that has none yet', async () => {
      codeFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ code: CODE });
      codeCreate.mockImplementation(async ({ data }: any) => ({
         code: data.code,
      }));
      eventAggregate.mockResolvedValue({ _sum: { amount: '0' } });
      referralFindMany.mockResolvedValue([]);
      mockCounts(0, 0);

      const result = await getReferralEarnings(REFERRER, { limit: 20 });

      expect(result.referralCode).toHaveLength(REFERRAL_CODE_LENGTH);
      expect(codeCreate).toHaveBeenCalledTimes(1);
   });

   it('only aggregates fees for the referees on the current page', async () => {
      eventAggregate.mockResolvedValue({ _sum: { amount: '3' } });
      referralFindMany.mockResolvedValue([referralRow({ id: 'ref-1' })]);
      eventGroupBy.mockResolvedValue([
         { refereeAddress: REFEREE, _sum: { amount: '3' } },
      ]);
      mockCounts(1, 1);

      await getReferralEarnings(REFERRER, { limit: 1 });

      expect(eventGroupBy).toHaveBeenCalledWith({
         by: ['refereeAddress'],
         where: {
            walletAddress: REFERRER,
            refereeAddress: { in: [REFEREE] },
         },
         _sum: { amount: true },
      });
   });
});

describe('getReferralStats', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      protocolConfigUpsert.mockResolvedValue({ protocolFeeBps: 500 });
   });

   it('returns referral count, tier, total earned, and pending claim', async () => {
      referralCount.mockResolvedValue(5);
      eventAggregate.mockResolvedValue({ _sum: { amount: '25.5' } });

      const stats = await getReferralStats(REFERRER);

      expect(stats).toEqual({
         referralCount: 5,
         tier: 'BRONZE',
         totalEarned: 25.5,
         pendingClaim: 25.5,
      });
   });

   it('returns SILVER tier for 10-49 referrals', async () => {
      referralCount.mockResolvedValue(25);
      eventAggregate.mockResolvedValue({ _sum: { amount: '100' } });

      const stats = await getReferralStats(REFERRER);

      expect(stats.tier).toBe('SILVER');
   });

   it('returns GOLD tier for 50+ referrals', async () => {
      referralCount.mockResolvedValue(75);
      eventAggregate.mockResolvedValue({ _sum: { amount: '500' } });

      const stats = await getReferralStats(REFERRER);

      expect(stats.tier).toBe('GOLD');
   });
});

describe('listReferredWallets', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      eventGroupBy.mockResolvedValue([]);
   });

   it('returns the join date and first-trade status for each referred wallet', async () => {
      const firstTradeAt = new Date('2026-09-05T12:00:00.000Z');
      referralFindMany.mockResolvedValue([
         referralRow({
            id: 'ref-1',
            refereeAddress: REFEREE,
            firstTradeAt,
         }),
         referralRow({
            id: 'ref-2',
            refereeAddress: REFEREE_2,
            firstTradeAt: null,
         }),
      ]);
      eventGroupBy.mockResolvedValue([
         { refereeAddress: REFEREE, _sum: { amount: '4.5' } },
      ]);

      const page = await listReferredWallets(REFERRER, { limit: 20 });

      expect(page.has_more).toBe(false);
      expect(page.next_cursor).toBeNull();
      expect(page.items).toEqual([
         {
            refereeAddress: REFEREE,
            joinedAt: '2026-09-01T10:00:00.000Z',
            firstTradeAt: '2026-09-05T12:00:00.000Z',
            hasCompletedFirstTrade: true,
            status: 'ACTIVE',
            earnedXlm: 4.5,
         },
         {
            refereeAddress: REFEREE_2,
            joinedAt: '2026-09-01T10:00:00.000Z',
            firstTradeAt: null,
            hasCompletedFirstTrade: false,
            status: 'PENDING',
            earnedXlm: 0,
         },
      ]);
   });

   it('orders referred wallets by join time, newest first', async () => {
      referralFindMany.mockResolvedValue([]);

      await listReferredWallets(REFERRER, { limit: 20 });

      expect(referralFindMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { referrerAddress: REFERRER },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
         })
      );
   });

   it('fetches one extra row to detect whether a next page exists', async () => {
      referralFindMany.mockResolvedValue([
         referralRow({ id: 'ref-1', refereeAddress: REFEREE }),
         referralRow({ id: 'ref-2', refereeAddress: REFEREE_2 }),
      ]);

      const page = await listReferredWallets(REFERRER, { limit: 1 });

      expect(referralFindMany).toHaveBeenCalledWith(
         expect.objectContaining({ take: 2 })
      );
      expect(page.items).toHaveLength(1);
      expect(page.has_more).toBe(true);
      expect(page.next_cursor).not.toBeNull();
   });

   it('applies keyset filtering from the supplied cursor', async () => {
      referralFindMany.mockResolvedValue([]);

      await listReferredWallets(REFERRER, {
         limit: 20,
         cursor: encodeCursor({
            joinedAt: '2026-09-01T10:00:00.000Z',
            id: 'ref-1',
         }),
      });

      expect(referralFindMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: {
               referrerAddress: REFERRER,
               OR: [
                  { createdAt: { lt: new Date('2026-09-01T10:00:00.000Z') } },
                  {
                     createdAt: { lte: new Date('2026-09-01T10:00:00.000Z') },
                     id: { lt: 'ref-1' },
                  },
               ],
            },
         })
      );
   });

   it('rejects a tampered cursor', async () => {
      await expect(
         listReferredWallets(REFERRER, { limit: 20, cursor: 'tampered.cursor' })
      ).rejects.toThrow(/cursor/i);
      expect(referralFindMany).not.toHaveBeenCalled();
   });
});

describe('recordTradeReferralReward', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      protocolConfigUpsert.mockResolvedValue({ protocolFeeBps: 500 });
      // No verdict yet, and detection finds nothing wrong, unless a test says so.
      holdFindUnique.mockReset();
      holdFindUnique.mockResolvedValue(null);
      abuseEvaluate.mockReset();
      abuseEvaluate.mockResolvedValue({ action: 'allow' });
   });

   it('records the referral reward on every trade with tier multiplier', async () => {
      const tradeAt = new Date('2026-09-05T12:00:00.000Z');
      referralFindUnique.mockResolvedValue({ referrerAddress: REFERRER });
      referralCount.mockResolvedValue(5); // Bronze tier (1x)
      eventCreate.mockResolvedValue({});

      const paid = await recordTradeReferralReward({
         refereeAddress: REFEREE,
         keyId: 'key-1',
         tradeValueXlm: 10,
         txHash: 'tx-1',
         eventIndex: 0,
         tradeAt,
      });

      expect(paid).toBe(true);
      // No firstTradeAt update anymore
      expect(referralUpdateMany).not.toHaveBeenCalled();
      // Reward = trade_value * protocol_fee_bps/10000 * REFERRAL_REWARD_BPS/10000 * tier_multiplier
      // = 10 * 500/10000 * 500/10000 * 1.0 = 10 * 0.05 * 0.05 * 1.0 = 0.025
      expect(eventCreate).toHaveBeenCalledWith({
         data: {
            walletAddress: REFERRER,
            refereeAddress: REFEREE,
            keyId: 'key-1',
            amount: 0.025,
            tierMultiplier: 1.0,
            txHash: 'tx-1',
            eventIndex: 0,
            createdAt: tradeAt,
         },
      });
   });

   it('applies 1.5x tier multiplier for SILVER tier (10-49 referrals)', async () => {
      const tradeAt = new Date('2026-09-05T12:00:00.000Z');
      referralFindUnique.mockResolvedValue({ referrerAddress: REFERRER });
      referralCount.mockResolvedValue(25); // Silver tier (1.5x)
      eventCreate.mockResolvedValue({});

      const paid = await recordTradeReferralReward({
         refereeAddress: REFEREE,
         keyId: 'key-1',
         tradeValueXlm: 10,
         tradeAt,
      });

      expect(paid).toBe(true);
      // Reward = 10 * 0.05 * 0.05 * 1.5 = 0.0375
      expect(eventCreate).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               amount: 0.0375,
               tierMultiplier: 1.5,
            }),
         })
      );
   });

   it('applies 2x tier multiplier for GOLD tier (50+ referrals)', async () => {
      const tradeAt = new Date('2026-09-05T12:00:00.000Z');
      referralFindUnique.mockResolvedValue({ referrerAddress: REFERRER });
      referralCount.mockResolvedValue(75); // Gold tier (2x)
      eventCreate.mockResolvedValue({});

      const paid = await recordTradeReferralReward({
         refereeAddress: REFEREE,
         keyId: 'key-1',
         tradeValueXlm: 10,
         tradeAt,
      });

      expect(paid).toBe(true);
      // Reward = 10 * 0.05 * 0.05 * 2.0 = 0.05
      expect(eventCreate).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               amount: 0.05,
               tierMultiplier: 2.0,
            }),
         })
      );
   });

   it('does not record a fee for a wallet that was never referred', async () => {
      referralFindUnique.mockResolvedValue(null);

      const paid = await recordTradeReferralReward({
         refereeAddress: REFEREE,
         keyId: 'key-1',
         tradeValueXlm: 10,
      });

      expect(paid).toBe(false);
      expect(eventCreate).not.toHaveBeenCalled();
   });

   it('records a fee on every trade (not just first trade)', async () => {
      const tradeAt = new Date('2026-09-05T12:00:00.000Z');
      referralFindUnique.mockResolvedValue({ referrerAddress: REFERRER });
      referralCount.mockResolvedValue(5);
      eventCreate.mockResolvedValue({});

      // First trade
      await expect(
         recordTradeReferralReward({
            refereeAddress: REFEREE,
            keyId: 'key-1',
            tradeValueXlm: 10,
            tradeAt,
         })
      ).resolves.toBe(true);

      // Second trade - should also pay out
      await expect(
         recordTradeReferralReward({
            refereeAddress: REFEREE,
            keyId: 'key-2',
            tradeValueXlm: 25,
            tradeAt,
         })
      ).resolves.toBe(true);

      expect(eventCreate).toHaveBeenCalledTimes(2);
   });

   it('skips the fee row when the reward rounds to zero', async () => {
      referralFindUnique.mockResolvedValue({ referrerAddress: REFERRER });
      referralCount.mockResolvedValue(5);
      eventCreate.mockResolvedValue({});

      const paid = await recordTradeReferralReward({
         refereeAddress: REFEREE,
         keyId: 'key-1',
         tradeValueXlm: 0,
      });

      expect(paid).toBe(false);
      expect(eventCreate).not.toHaveBeenCalled();
   });

   describe('abuse detection (#1241)', () => {
      const tradeAt = new Date('2026-09-05T12:00:00.000Z');
      const trade = {
         refereeAddress: REFEREE,
         keyId: 'key-1',
         tradeValueXlm: 10,
         txHash: 'tx-1',
         eventIndex: 3,
         tradeAt,
      };
      // 10 XLM * 500/10000 * 500/10000 * 1.0
      const REWARD = 0.025;

      beforeEach(() => {
         referralFindUnique.mockResolvedValue(referralRow());
         referralCount.mockResolvedValue(5);
         eventCreate.mockResolvedValue({});
         holdUpdateMany.mockResolvedValue({ count: 1 });
         holdRewardCreate.mockResolvedValue({});
      });

      it('pays a normal referral unchanged and creates no hold', async () => {
         await expect(recordTradeReferralReward(trade)).resolves.toBe(true);

         expect(abuseEvaluate).toHaveBeenCalledWith({
            referrerAddress: REFERRER,
            refereeAddress: REFEREE,
         });
         expect(eventCreate).toHaveBeenCalledTimes(1);
         expect(holdUpsert).not.toHaveBeenCalled();
         expect(holdRewardCreate).not.toHaveBeenCalled();
      });

      it('withholds a flagged referral: records a PENDING hold and the reward, pays nothing', async () => {
         abuseEvaluate.mockResolvedValue({
            action: 'hold',
            reason: 'FUNDING_CLUSTER',
            details: { funder: 'GFUNDER', refereesInWindow: 6 },
         });
         holdUpsert.mockResolvedValue({ id: 'hold-1', status: 'PENDING' });

         await expect(recordTradeReferralReward(trade)).resolves.toBe(false);

         expect(eventCreate).not.toHaveBeenCalled();
         expect(holdUpsert).toHaveBeenCalledWith({
            where: { referralId: 'ref-1' },
            create: {
               referralId: 'ref-1',
               reason: 'FUNDING_CLUSTER',
               status: 'PENDING',
               details: { funder: 'GFUNDER', refereesInWindow: 6 },
               referrerAddress: REFERRER,
               refereeAddress: REFEREE,
            },
            update: {},
            select: { id: true, status: true },
         });
         expect(holdRewardCreate).toHaveBeenCalledWith({
            data: {
               holdId: 'hold-1',
               keyId: 'key-1',
               rewardXlm: REWARD,
               tierMultiplier: 1.0,
               txHash: 'tx-1',
               eventIndex: 3,
               tradedAt: tradeAt,
            },
         });
      });

      it('records the reason of a rejected self-referral as a REJECTED hold and withholds nothing', async () => {
         referralFindUnique.mockResolvedValue(
            referralRow({ referrerAddress: REFEREE })
         );
         abuseEvaluate.mockResolvedValue({
            action: 'reject',
            reason: 'SELF_REFERRAL',
            details: { wallet: REFEREE },
         });
         holdUpsert.mockResolvedValue({ id: 'hold-1', status: 'REJECTED' });

         await expect(recordTradeReferralReward(trade)).resolves.toBe(false);

         expect(holdUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
               create: expect.objectContaining({
                  reason: 'SELF_REFERRAL',
                  status: 'REJECTED',
               }),
            })
         );
         expect(holdRewardCreate).not.toHaveBeenCalled();
         expect(eventCreate).not.toHaveBeenCalled();
      });

      it('keeps withholding every later trade while the hold is PENDING, without re-evaluating', async () => {
         holdFindUnique.mockResolvedValue({ id: 'hold-1', status: 'PENDING' });

         await expect(recordTradeReferralReward(trade)).resolves.toBe(false);
         await expect(
            recordTradeReferralReward({ ...trade, keyId: 'key-2', eventIndex: 4 })
         ).resolves.toBe(false);

         expect(abuseEvaluate).not.toHaveBeenCalled();
         expect(holdUpsert).not.toHaveBeenCalled();
         expect(holdRewardCreate).toHaveBeenCalledTimes(2);
         expect(eventCreate).not.toHaveBeenCalled();
      });

      it('never pays a referral whose hold was rejected', async () => {
         holdFindUnique.mockResolvedValue({ id: 'hold-1', status: 'REJECTED' });

         await expect(recordTradeReferralReward(trade)).resolves.toBe(false);

         expect(abuseEvaluate).not.toHaveBeenCalled();
         expect(holdRewardCreate).not.toHaveBeenCalled();
         expect(eventCreate).not.toHaveBeenCalled();
      });

      it('pays later trades normally once the hold was released, without re-evaluating', async () => {
         holdFindUnique.mockResolvedValue({ id: 'hold-1', status: 'RELEASED' });

         await expect(recordTradeReferralReward(trade)).resolves.toBe(true);

         expect(abuseEvaluate).not.toHaveBeenCalled();
         expect(holdRewardCreate).not.toHaveBeenCalled();
         expect(eventCreate).toHaveBeenCalledTimes(1);
      });

      it('pays directly when the hold is released while the trade is in flight', async () => {
         holdFindUnique.mockResolvedValue({ id: 'hold-1', status: 'PENDING' });
         holdUpdateMany.mockResolvedValue({ count: 0 }); // lock sees RELEASED

         await expect(recordTradeReferralReward(trade)).resolves.toBe(true);

         expect(holdRewardCreate).not.toHaveBeenCalled();
         expect(eventCreate).toHaveBeenCalledTimes(1);
      });

      it('propagates an evaluation failure without writing anything', async () => {
         abuseEvaluate.mockRejectedValue(new Error('Horizon unavailable'));

         await expect(recordTradeReferralReward(trade)).rejects.toThrow(
            'Horizon unavailable'
         );

         expect(holdUpsert).not.toHaveBeenCalled();
         expect(holdRewardCreate).not.toHaveBeenCalled();
         expect(eventCreate).not.toHaveBeenCalled();
      });

      it('does not evaluate a trade whose reward rounds to zero', async () => {
         await expect(
            recordTradeReferralReward({ ...trade, tradeValueXlm: 0 })
         ).resolves.toBe(false);
         expect(abuseEvaluate).not.toHaveBeenCalled();
      });
   });
});
