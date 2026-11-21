import { prisma } from '../../utils/prisma.utils';
import { buyGateway } from '../creator/buy.service';
import { getKeyFees } from '../keys/key-fees.service';
import { emitAutoInvestExecuted } from './auto-invest.events';
import {
   createAutoInvestRule,
   deleteAutoInvestRule,
   evaluateListing,
   getAutoInvestRule,
   listActiveAutoInvestRules,
   updateAutoInvestRule,
} from './auto-invest.service';

jest.mock('../../utils/prisma.utils', () => {
   const mockPrisma: any = {
      autoInvestRule: {
         create: jest.fn(),
         findMany: jest.fn(),
         findFirst: jest.fn(),
         update: jest.fn(),
         delete: jest.fn(),
      },
      autoInvestExecution: {
         create: jest.fn(),
         update: jest.fn(),
      },
      creatorProfile: {
         findUnique: jest.fn(),
      },
      creatorPriceSnapshot: {
         findUnique: jest.fn(),
      },
      stellarWallet: {
         findUnique: jest.fn(),
      },
      $transaction: jest.fn(async (arg: any) => {
         if (typeof arg === 'function') return arg(mockPrisma);
         return Promise.all(arg);
      }),
   };
   return { prisma: mockPrisma };
});

jest.mock('../creator/buy.service', () => ({
   buyGateway: {
      getXlmBalance: jest.fn(),
      submitBuy: jest.fn(),
   },
}));

jest.mock('../keys/key-fees.service', () => ({
   getKeyFees: jest.fn(),
   KeyNotFoundError: class KeyNotFoundError extends Error {
      constructor(public keyId: string) {
         super(`Key not found: ${keyId}`);
         this.name = 'KeyNotFoundError';
      }
   },
}));

jest.mock('./auto-invest.events', () => ({
   emitAutoInvestExecuted: jest.fn(),
}));

const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASH';
const LISTING = 'creator-1';
const RULE_ID = 'rule-1';

const baseRule = {
   id: RULE_ID,
   walletAddress: WALLET,
   category: 'music',
   minRating: null,
   maxPrice: '5',
   maxPerKey: 1,
   isActive: true,
   createdAt: new Date(),
   updatedAt: new Date(),
};

describe('auto-invest service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (prisma.autoInvestExecution.create as jest.Mock).mockResolvedValue({
         id: 'exec-1',
      });
      (prisma.autoInvestExecution.update as jest.Mock).mockResolvedValue({});
      (getKeyFees as jest.Mock).mockResolvedValue({
         protocolFeeBps: 500,
         creatorRoyaltyBuyBps: 0,
         creatorRoyaltySellBps: 0,
      });
      (buyGateway.getXlmBalance as jest.Mock).mockResolvedValue(100);
      (buyGateway.submitBuy as jest.Mock).mockResolvedValue({
         transactionHash: 'tx-hash',
      });
   });

   describe('CRUD', () => {
      it('creates a rule owned by the authenticated wallet', async () => {
         (prisma.autoInvestRule.create as jest.Mock).mockResolvedValue(baseRule);

         const rule = await createAutoInvestRule(WALLET, {
            category: 'music',
            minRating: null,
            maxPrice: '5',
            maxPerKey: 1,
         });

         expect(prisma.autoInvestRule.create).toHaveBeenCalledWith({
            data: {
               walletAddress: WALLET,
               category: 'music',
               minRating: null,
               maxPrice: '5',
               maxPerKey: 1,
               isActive: true,
            },
         });
         expect(rule.walletAddress).toBe(WALLET);
         expect(rule.category).toBe('music');
      });

      it('lists only active rules for the wallet', async () => {
         const rules = [baseRule, { ...baseRule, isActive: false }];
         (prisma.autoInvestRule.findMany as jest.Mock).mockImplementation(
            (args: any) => {
               const filtered = rules.filter(
                  (r) =>
                     r.walletAddress === args.where.walletAddress &&
                     (args.where.isActive === undefined ||
                        r.isActive === args.where.isActive)
               );
               return Promise.resolve(filtered);
            }
         );

         const result = await listActiveAutoInvestRules(WALLET);

         expect(prisma.autoInvestRule.findMany).toHaveBeenCalledWith({
            where: { walletAddress: WALLET, isActive: true },
            orderBy: { createdAt: 'desc' },
         });
         expect(result).toHaveLength(1);
         expect(result[0].isActive).toBe(true);
      });

      it('returns null for a rule owned by another wallet', async () => {
         (prisma.autoInvestRule.findFirst as jest.Mock).mockResolvedValue(null);

         const result = await getAutoInvestRule(RULE_ID, 'different-wallet');

         expect(prisma.autoInvestRule.findFirst).toHaveBeenCalledWith({
            where: { id: RULE_ID, walletAddress: 'different-wallet' },
         });
         expect(result).toBeNull();
      });

      it('updates only provided fields (partial update preserves others)', async () => {
         const existing = { ...baseRule, category: 'music', maxPrice: '5' };
         (prisma.autoInvestRule.findFirst as jest.Mock).mockResolvedValue(existing);
         const updated = { ...existing, maxPrice: '10' };
         (prisma.autoInvestRule.update as jest.Mock).mockResolvedValue(updated);

         const rule = await updateAutoInvestRule(RULE_ID, WALLET, {
            maxPrice: '10',
         });

         expect(prisma.autoInvestRule.update).toHaveBeenCalledWith({
            where: { id: RULE_ID },
            data: { maxPrice: '10' },
         });
         expect(rule!.maxPrice).toBe('10');
      });

      it('toggles a rule inactive', async () => {
         const existing = { ...baseRule, isActive: true };
         (prisma.autoInvestRule.findFirst as jest.Mock).mockResolvedValue(existing);
         const updated = { ...existing, isActive: false };
         (prisma.autoInvestRule.update as jest.Mock).mockResolvedValue(updated);

         const rule = await updateAutoInvestRule(RULE_ID, WALLET, {
            isActive: false,
         });

         expect(rule!.isActive).toBe(false);
      });

      it('deletes a rule owned by the wallet', async () => {
         (prisma.autoInvestRule.findFirst as jest.Mock).mockResolvedValue(baseRule);
         (prisma.autoInvestRule.delete as jest.Mock).mockResolvedValue(baseRule);

         const deleted = await deleteAutoInvestRule(RULE_ID, WALLET);

         expect(deleted).toBe(true);
         expect(prisma.autoInvestRule.delete).toHaveBeenCalledWith({
            where: { id: RULE_ID },
         });
      });

      it('returns false when deleting a rule owned by another wallet', async () => {
         (prisma.autoInvestRule.findFirst as jest.Mock).mockResolvedValue(null);

         const deleted = await deleteAutoInvestRule(RULE_ID, 'other-wallet');

         expect(deleted).toBe(false);
         expect(prisma.autoInvestRule.delete).not.toHaveBeenCalled();
      });

      it('returns null for a nonexistent rule on update', async () => {
         (prisma.autoInvestRule.findFirst as jest.Mock).mockResolvedValue(null);

         const result = await updateAutoInvestRule('nope', WALLET, {
            isActive: false,
         });

         expect(result).toBeNull();
      });
   });

   describe('evaluateListing', () => {
      const key = {
         id: LISTING,
         category: 'music',
         rating: 4.5,
         circulatingSupply: 10,
      };
      const priceSnapshot = { currentPrice: 10_000_000 }; // 1 XLM in stroops

      const matchingRule = {
         ...baseRule,
         category: 'music',
         minRating: null,
         maxPrice: '5', // 5 XLM
         maxPerKey: 1,
      };

      async function setupListing() {
         (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue(key);
         (prisma.creatorPriceSnapshot.findUnique as jest.Mock).mockResolvedValue(
            priceSnapshot
         );
         (prisma.autoInvestRule.findMany as jest.Mock).mockResolvedValue([
            matchingRule,
         ]);
      }

      it('executes a qualifying purchase and emits AutoInvestExecuted', async () => {
         await setupListing();
         const result = await evaluateListing(LISTING);

         expect(buyGateway.submitBuy).toHaveBeenCalledWith({
            walletAddress: WALLET,
            creatorId: LISTING,
            quantity: 1,
         });
         expect(emitAutoInvestExecuted).toHaveBeenCalledWith({
            ruleId: RULE_ID,
            listingId: LISTING,
            walletAddress: WALLET,
            transactionHash: 'tx-hash',
         });
         expect(result.executed).toBe(1);
         expect(result.results[0].outcome).toBe('executed');
      });

      it('skips when category does not match', async () => {
         (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({
            ...key,
            category: 'art',
         });
         (prisma.creatorPriceSnapshot.findUnique as jest.Mock).mockResolvedValue(
            priceSnapshot
         );
         (prisma.autoInvestRule.findMany as jest.Mock).mockResolvedValue([]);

         const result = await evaluateListing(LISTING);
         expect(result.evaluated).toBe(0);
         expect(result.executed).toBe(0);
      });

      it('skips when rating is below the minimum', async () => {
         const highMin = { ...matchingRule, minRating: 4.6 };
         (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue(key);
         (prisma.creatorPriceSnapshot.findUnique as jest.Mock).mockResolvedValue(
            priceSnapshot
         );
         (prisma.autoInvestRule.findMany as jest.Mock).mockResolvedValue([
            highMin,
         ]);

         const result = await evaluateListing(LISTING);
         expect(result.executed).toBe(0);
         expect(result.results[0].outcome).toBe('ineligible');
      });

      it('skips when rating is missing and minRating is set', async () => {
         const highMin = { ...matchingRule, minRating: 1 };
         (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue({
            ...key,
            rating: null,
         });
         (prisma.creatorPriceSnapshot.findUnique as jest.Mock).mockResolvedValue(
            priceSnapshot
         );
         (prisma.autoInvestRule.findMany as jest.Mock).mockResolvedValue([
            highMin,
         ]);

         const result = await evaluateListing(LISTING);
         expect(result.executed).toBe(0);
         expect(result.results[0].outcome).toBe('ineligible');
      });

      it('skips when price is above the maximum', async () => {
         const lowMax = { ...matchingRule, maxPrice: '0.5' }; // 0.5 XLM < 1 XLM
         (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue(key);
         (prisma.creatorPriceSnapshot.findUnique as jest.Mock).mockResolvedValue(
            priceSnapshot
         );
         (prisma.autoInvestRule.findMany as jest.Mock).mockResolvedValue([
            lowMax,
         ]);

         const result = await evaluateListing(LISTING);
         expect(result.executed).toBe(0);
         expect(result.results[0].outcome).toBe('ineligible');
      });

      it('does not execute inactive rules', async () => {
         const inactive = { ...matchingRule, isActive: false };
         (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue(key);
         (prisma.creatorPriceSnapshot.findUnique as jest.Mock).mockResolvedValue(
            priceSnapshot
         );
         (prisma.autoInvestRule.findMany as jest.Mock).mockResolvedValue([
            inactive,
         ]);

         const result = await evaluateListing(LISTING);
         expect(result.executed).toBe(0);
      });

      it('skips on insufficient balance', async () => {
         await setupListing();
         (buyGateway.getXlmBalance as jest.Mock).mockResolvedValue(0.001); // underfunded

         const result = await evaluateListing(LISTING);

         expect(result.executed).toBe(0);
         expect(result.skipped).toBe(1);
         expect(result.results[0].outcome).toBe('skipped');
         expect(emitAutoInvestExecuted).not.toHaveBeenCalled();
      });

      it('does not emit a success event when purchase fails', async () => {
         await setupListing();
         (buyGateway.submitBuy as jest.Mock).mockRejectedValue(
            new Error('on-chain failure')
         );

         const result = await evaluateListing(LISTING);

         expect(result.executed).toBe(0);
         expect(result.failed).toBe(1);
         expect(emitAutoInvestExecuted).not.toHaveBeenCalled();
      });

      it('evaluates multiple rules for the same wallet independently', async () => {
         const ruleA = { ...matchingRule, id: 'rule-a', maxPrice: '5' };
         const ruleB = { ...matchingRule, id: 'rule-b', maxPrice: '5' };
         (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue(key);
         (prisma.creatorPriceSnapshot.findUnique as jest.Mock).mockResolvedValue(
            priceSnapshot
         );
         (prisma.autoInvestRule.findMany as jest.Mock).mockResolvedValue([
            ruleA,
            ruleB,
         ]);

         const result = await evaluateListing(LISTING);
         expect(result.executed).toBe(2);
         expect(result.results.map((r) => r.ruleId).sort()).toEqual([
            'rule-a',
            'rule-b',
         ]);
      });

      it('lets one failing rule not block another', async () => {
         const ruleA = { ...matchingRule, id: 'rule-a', maxPrice: '5' };
         const ruleB = { ...matchingRule, id: 'rule-b', maxPrice: '0.1' }; // price mismatch
         (prisma.creatorProfile.findUnique as jest.Mock).mockResolvedValue(key);
         (prisma.creatorPriceSnapshot.findUnique as jest.Mock).mockResolvedValue(
            priceSnapshot
         );
         (prisma.autoInvestRule.findMany as jest.Mock).mockResolvedValue([
            ruleA,
            ruleB,
         ]);

         const result = await evaluateListing(LISTING);
         expect(result.executed).toBe(1);
         expect(result.results[0].outcome).toBe('executed');
      });

      it('enforces maxPerKey quantity', async () => {
         const rule = { ...matchingRule, maxPerKey: 3 };
         await setupListing();
         (prisma.autoInvestRule.findMany as jest.Mock).mockResolvedValue([rule]);

         await evaluateListing(LISTING);

         expect(buyGateway.submitBuy).toHaveBeenCalledWith({
            walletAddress: WALLET,
            creatorId: LISTING,
            quantity: 3,
         });
      });

      it('is idempotent: duplicate execution for same rule+listing is rejected', async () => {
         await setupListing();
         const uniqueError: any = new Error('unique');
         uniqueError.code = 'P2002';
         (prisma.autoInvestExecution.create as jest.Mock).mockRejectedValueOnce(
            uniqueError
         );

         const result = await evaluateListing(LISTING);

         expect(result.results[0].outcome).toBe('duplicate');
         expect(result.executed).toBe(0);
      });
   });
});
