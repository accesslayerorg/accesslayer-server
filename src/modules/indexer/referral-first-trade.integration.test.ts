// Wires the referral trade reward into the trade indexer (#1198):
//   - both KEY_BOUGHT and KEY_SOLD events trigger the referral reward
//   - a referral bookkeeping failure aborts the event before trade writes
//
// The reward logic itself is covered in ../referrals/referrals.service.test.ts.

jest.mock('../../utils/prisma.utils', () => {
   const activityFindMany = jest.fn().mockResolvedValue([]);
   const activityCreate = jest.fn();
   const creatorProfileFindUnique = jest.fn().mockResolvedValue(null);
   const creatorProfileUpdate = jest.fn();
   
   const transactionClient = {
      activity: { findMany: activityFindMany, create: activityCreate },
      creatorProfile: { findUnique: creatorProfileFindUnique, update: creatorProfileUpdate },
   };
   return {
      prisma: {
         activity: { create: activityCreate },
         keyOwnership: {
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            upsert: jest.fn(),
            aggregate: jest.fn(),
         },
         creatorPriceSnapshot: {
            findUnique: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
         },
         creatorPriceHistory: { create: jest.fn() },
         creatorProfile: { findUnique: creatorProfileFindUnique },
         indexedLedger: { upsert: jest.fn() },
         $transaction: jest.fn(async (arg: any) => {
            if (typeof arg === 'function') {
               return arg(transactionClient);
            }
            // Array of promises
            return Promise.all(arg);
         }),
      },
   };
});

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   getRedis: jest.fn(() => ({ del: jest.fn().mockResolvedValue(1) })),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../referrals/referrals.service', () => ({
   recordTradeReferralReward: jest.fn().mockResolvedValue(false),
}));

import { processTradeEvents } from './indexer-pipeline.service';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { recordTradeReferralReward } from '../referrals/referrals.service';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

const recordReward = recordTradeReferralReward as jest.Mock;
const mockLogger = logger as unknown as { warn: jest.Mock };

const BUYER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function buyEvent(
   overrides: Partial<IndexerChainEvent> = {}
): IndexerChainEvent {
   return {
      txHash: '0xhash-buy',
      eventIndex: 0,
      eventType: 'KEY_BOUGHT',
      ledger: 20000,
      creatorId: 'creator-abc',
      actor: BUYER,
      amount: 2,
      // 1.5 XLM per key, in stroops
      price: 15_000_000n,
      feePaid: 10n,
      tradeAt: '2026-09-05T12:00:00.000Z',
      ...overrides,
   } as IndexerChainEvent;
}

describe('referral reward wiring in processTradeEvents', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (prisma as any).keyOwnership.upsert.mockResolvedValue({ balance: 2 });
      (prisma as any).keyOwnership.findFirst.mockResolvedValue(null);
      (prisma as any).keyOwnership.findUnique.mockResolvedValue(null);
      (prisma as any).keyOwnership.aggregate.mockResolvedValue({
         _sum: { balance: 2 },
      });
      (prisma as any).indexedLedger.upsert.mockResolvedValue({});
   });

   it('records the referral reward with the total XLM value of the buy', async () => {
      await processTradeEvents([buyEvent()]);

      expect(recordReward).toHaveBeenCalledTimes(1);
      expect(recordReward).toHaveBeenCalledWith({
         refereeAddress: BUYER,
         keyId: 'creator-abc',
         // 1.5 XLM * 2 keys
         tradeValueXlm: 3,
         txHash: '0xhash-buy',
         eventIndex: 0,
         tradeAt: new Date('2026-09-05T12:00:00.000Z'),
      });
   });

   it('records the referral reward check for sells as well as buys', async () => {
      await processTradeEvents([
         buyEvent({ eventType: 'KEY_SOLD', txHash: '0xhash-sell' }),
      ]);

      expect(recordReward).toHaveBeenCalledWith(
         expect.objectContaining({
            refereeAddress: BUYER,
            keyId: 'creator-abc',
            tradeValueXlm: 3,
            txHash: '0xhash-sell',
         })
      );
   });

   it('aborts the event before trade writes when referral bookkeeping fails', async () => {
      recordReward.mockRejectedValueOnce(new Error('referral table locked'));

      await expect(processTradeEvents([buyEvent()])).rejects.toThrow(
         'referral table locked'
      );

      expect((prisma as any).activity.create).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
         expect.objectContaining({ eventId: '0xhash-buy:0' }),
         'Failed to record referral trade reward'
      );
   });
});
