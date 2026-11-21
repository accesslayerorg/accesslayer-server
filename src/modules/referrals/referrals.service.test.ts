// Unit tests: referral tracking and reward distribution (#910)
//
// Covers the acceptance criteria:
//   - referral registration stores the relationship correctly
//   - earnings endpoint returns accurate totals and a per-referral breakdown
//   - referred wallets list shows join date and first-trade status
//   - referral fee is recorded only on the referred wallet's first trade
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
   const prisma = {
      referralCode: { findUnique: jest.fn(), create: jest.fn() },
      referral,
      referralEvent,
      $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
         callback({ referral, referralEvent })
      ),
   };

   return { prisma };
});

import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { encodeCursor } from '../../utils/cursor.utils';
import {
   AlreadyReferredError,
   generateReferralCode,
   getOrCreateReferralCode,
   getReferralEarnings,
   listReferredWallets,
   recordFirstTradeReferralReward,
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

describe('recordFirstTradeReferralReward', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('records the referral fee against the referrer on the first trade', async () => {
      const tradeAt = new Date('2026-09-05T12:00:00.000Z');
      referralUpdateMany.mockResolvedValue({ count: 1 });
      referralFindUnique.mockResolvedValue({ referrerAddress: REFERRER });
      eventCreate.mockResolvedValue({});

      const paid = await recordFirstTradeReferralReward({
         refereeAddress: REFEREE,
         keyId: 'key-1',
         tradeValueXlm: 10,
         txHash: 'tx-1',
         eventIndex: 0,
         tradeAt,
      });

      expect(paid).toBe(true);
      expect(referralUpdateMany).toHaveBeenCalledWith({
         where: { refereeAddress: REFEREE, firstTradeAt: null },
         data: { firstTradeAt: tradeAt, firstTradeKeyId: 'key-1' },
      });
      // 10 XLM * 500bps = 0.5 XLM
      expect(eventCreate).toHaveBeenCalledWith({
         data: {
            walletAddress: REFERRER,
            refereeAddress: REFEREE,
            keyId: 'key-1',
            amount: 0.5,
            txHash: 'tx-1',
            eventIndex: 0,
            createdAt: tradeAt,
         },
      });
   });

   it('does not record a fee for a wallet that was never referred', async () => {
      referralUpdateMany.mockResolvedValue({ count: 0 });

      const paid = await recordFirstTradeReferralReward({
         refereeAddress: REFEREE,
         keyId: 'key-1',
         tradeValueXlm: 10,
      });

      expect(paid).toBe(false);
      expect(eventCreate).not.toHaveBeenCalled();
   });

   it('records a fee only once across repeated trades', async () => {
      referralUpdateMany
         .mockResolvedValueOnce({ count: 1 })
         .mockResolvedValueOnce({ count: 0 });
      referralFindUnique.mockResolvedValue({ referrerAddress: REFERRER });
      eventCreate.mockResolvedValue({});

      await expect(
         recordFirstTradeReferralReward({
            refereeAddress: REFEREE,
            keyId: 'key-1',
            tradeValueXlm: 10,
         })
      ).resolves.toBe(true);
      await expect(
         recordFirstTradeReferralReward({
            refereeAddress: REFEREE,
            keyId: 'key-2',
            tradeValueXlm: 25,
         })
      ).resolves.toBe(false);

      expect(eventCreate).toHaveBeenCalledTimes(1);
   });

   it('stamps the first trade but skips the fee row when the reward rounds to zero', async () => {
      const bps = envConfig.REFERRAL_REWARD_BPS;
      referralUpdateMany.mockResolvedValue({ count: 1 });
      referralFindUnique.mockResolvedValue({ referrerAddress: REFERRER });
      eventCreate.mockResolvedValue({});

      const paid = await recordFirstTradeReferralReward({
         refereeAddress: REFEREE,
         keyId: 'key-1',
         tradeValueXlm: 0,
      });

      expect(bps).toBeGreaterThanOrEqual(0);
      expect(paid).toBe(true);
      expect(referralUpdateMany).toHaveBeenCalled();
      expect(eventCreate).not.toHaveBeenCalled();
   });
});
