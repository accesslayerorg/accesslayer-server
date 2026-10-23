import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import {
   parseRevenueShareContractLog,
   processRevenueShareEvents,
} from './revenue-share-indexer.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      revenueDistribution: { findFirst: jest.fn(), findMany: jest.fn() },
      keyOwnership: { findMany: jest.fn() },
      revenueShareClaim: { findFirst: jest.fn(), create: jest.fn() },
      $transaction: jest.fn(),
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheInvalidate: jest.fn(),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

const mockPrisma = prisma as unknown as {
   revenueDistribution: { findFirst: jest.Mock; findMany: jest.Mock };
   keyOwnership: { findMany: jest.Mock };
   revenueShareClaim: { findFirst: jest.Mock; create: jest.Mock };
   $transaction: jest.Mock;
};
const mockCacheInvalidate = cacheInvalidate as jest.Mock;

describe('creator revenue share indexer', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.revenueDistribution.findFirst.mockResolvedValue(null);
      mockPrisma.revenueDistribution.findMany.mockResolvedValue([]);
      mockPrisma.keyOwnership.findMany.mockResolvedValue([
         { ownerAddress: 'GWALLET1', balance: 1 },
         { ownerAddress: 'GWALLET2', balance: 3 },
      ]);
      mockPrisma.$transaction.mockImplementation(
         async (callback: (transaction: unknown) => Promise<void>) =>
            callback({
               revenueDistribution: {
                  create: jest
                     .fn()
                     .mockResolvedValue({ id: 'distribution-db-1' }),
               },
               revenueDistributionShare: {
                  createMany: jest.fn().mockResolvedValue({ count: 2 }),
               },
            })
      );
      mockCacheInvalidate.mockResolvedValue(undefined);
   });

   it('records each distribution and snapshots proportional wallet shares', async () => {
      const tx = {
         revenueDistribution: {
            create: jest.fn().mockResolvedValue({ id: 'distribution-db-1' }),
         },
         revenueDistributionShare: {
            createMany: jest.fn().mockResolvedValue({ count: 2 }),
         },
      };
      mockPrisma.$transaction.mockImplementationOnce(
         async (callback: (transaction: unknown) => Promise<void>) =>
            callback(tx)
      );

      await processRevenueShareEvents([
         {
            eventType: 'RevenueDistributed',
            keyId: 'key-1',
            distributionId: 'chain-dist-1',
            amount: '12',
            distributedAt: '2026-10-20T10:00:00.000Z',
            holderCount: 2,
            ledger: 900,
            txHash: 'tx-distributed',
            eventIndex: 0,
         },
      ]);

      expect(tx.revenueDistribution.create).toHaveBeenCalledWith({
         data: expect.objectContaining({
            keyId: 'key-1',
            chainDistributionId: 'chain-dist-1',
            amount: '12',
            holderCount: 2,
            ledger: 900,
         }),
      });
      expect(tx.revenueDistributionShare.createMany).toHaveBeenCalledWith({
         data: [
            {
               distributionId: 'distribution-db-1',
               wallet: 'GWALLET1',
               amount: '3.0000000',
            },
            {
               distributionId: 'distribution-db-1',
               wallet: 'GWALLET2',
               amount: '9.0000000',
            },
         ],
      });
      expect(mockCacheInvalidate).toHaveBeenCalledWith(
         'key:revenue-distributions:key-1:*'
      );
   });

   it('indexes claim events idempotently and invalidates the key cache', async () => {
      mockPrisma.revenueShareClaim.findFirst.mockResolvedValue(null);
      mockPrisma.revenueDistribution.findMany.mockResolvedValue([
         {
            id: 'distribution-db-1',
            shares: [
               {
                  id: 'share-1',
                  amount: 5,
                  claims: [{ amount: 1 }],
               },
            ],
         },
      ]);
      mockPrisma.revenueShareClaim.create.mockResolvedValue({});

      await processRevenueShareEvents([
         {
            eventType: 'RevenueShareClaimed',
            keyId: 'key-1',
            wallet: 'GWALLET1',
            amount: '2',
            claimedAt: '2026-10-20T11:00:00.000Z',
            ledger: 901,
            txHash: 'tx-claimed',
            eventIndex: 3,
         },
      ]);

      expect(mockPrisma.revenueShareClaim.create).toHaveBeenCalledWith({
         data: expect.objectContaining({
            distributionId: 'distribution-db-1',
            shareId: 'share-1',
            wallet: 'GWALLET1',
            amount: '2',
         }),
      });
      expect(mockCacheInvalidate).toHaveBeenCalledWith(
         'key:revenue-distributions:key-1:*'
      );
   });

   it('fails a malformed event so the shared indexer cursor can retry it', async () => {
      await expect(
         processRevenueShareEvents([
            {
               eventType: 'RevenueDistributed',
               keyId: 'key-1',
               amount: 'not-a-number',
               ledger: 902,
               txHash: 'tx-invalid',
               eventIndex: 0,
            },
         ])
      ).rejects.toThrow('missing valid key, amount, date, or ledger');
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
   });

   it('parses Soroban RevenueShareClaimed logs', () => {
      expect(
         parseRevenueShareContractLog({
            contractId: 'contract-1',
            topics: [
               'revenue_share_claimed',
               'key-1',
               'GWALLET1',
               '2.5',
               'dist-1',
            ],
            ledger: 903,
            txHash: 'tx-raw-claim',
            timestamp: '2026-10-20T12:00:00.000Z',
            eventIndex: 1,
         })
      ).toEqual(
         expect.objectContaining({
            eventType: 'RevenueShareClaimed',
            keyId: 'key-1',
            wallet: 'GWALLET1',
            amount: '2.5',
            distributionId: 'dist-1',
         })
      );
   });
});
