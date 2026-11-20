import { prisma } from '../../utils/prisma.utils';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';
import {
   parseDividendContractLog,
   processDividendEvents,
} from './dividend-indexer.service';

jest.mock('../../utils/prisma.utils', () => {
   const mockPrismaClient = {
      activity: { create: jest.fn() },
      dividendClaim: {
         createMany: jest.fn(),
         findMany: jest.fn(),
         updateMany: jest.fn(),
      },
      dividendDistribution: {
         create: jest.fn(),
         findFirst: jest.fn(),
      },
      keyOwnership: { findMany: jest.fn() },
      $transaction: jest.fn(),
   };
   mockPrismaClient.$transaction.mockImplementation(
      async (callback: (client: typeof mockPrismaClient) => Promise<unknown>) =>
         callback(mockPrismaClient)
   );
   return { prisma: mockPrismaClient };
});

jest.mock('../dividends/dividend.service', () => ({
   invalidateDividendCache: jest.fn(),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
   },
}));

const mockPrisma = prisma as unknown as {
   activity: { create: jest.Mock };
   dividendClaim: {
      createMany: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
   };
   dividendDistribution: {
      create: jest.Mock;
      findFirst: jest.Mock;
   };
   keyOwnership: { findMany: jest.Mock };
   $transaction: jest.Mock;
};

describe('dividend indexer', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.keyOwnership.findMany.mockResolvedValue([
         { ownerAddress: 'G_WALLET', balance: 2 },
      ]);
      mockPrisma.dividendDistribution.create.mockResolvedValue({
         id: 'snapshot-db-id',
      });
      mockPrisma.dividendClaim.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.dividendClaim.findMany.mockResolvedValue([
         {
            id: 'claim-1',
            distributionId: 'snapshot-db-id',
            amountXlm: 12.5,
         },
      ]);
      mockPrisma.dividendClaim.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.dividendDistribution.findFirst.mockResolvedValue({
         id: 'snapshot-db-id',
      });
      mockPrisma.activity.create.mockResolvedValue({});
   });

   it('indexes DividendSnapshotCreated with its claim window and unique event index', async () => {
      const event: IndexerChainEvent = {
         eventType: 'DividendSnapshotCreated',
         creatorId: 'key-1',
         snapshotId: 'chain-snapshot-1',
         totalDistributed: '25',
         holdersCount: 1,
         distributedAt: '2026-10-18T12:00:00.000Z',
         claimWindowStart: '2026-10-18T12:00:00.000Z',
         claimWindowEnd: '2026-10-25T12:00:00.000Z',
         ledger: 200,
         txHash: 'tx-snapshot',
         eventIndex: 3,
      };

      await processDividendEvents([event], { advanceCursor: false });

      expect(mockPrisma.dividendDistribution.create).toHaveBeenCalledWith({
         data: expect.objectContaining({
            creatorId: 'key-1',
            totalAmountXlm: 25,
            claimWindowStart: new Date('2026-10-18T12:00:00.000Z'),
            claimWindowEnd: new Date('2026-10-25T12:00:00.000Z'),
            chainSnapshotId: 'chain-snapshot-1',
            ledger: 200,
            txHash: 'tx-snapshot',
            eventIndex: 3,
         }),
      });
      expect(mockPrisma.dividendClaim.createMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.dividendClaim.createMany).toHaveBeenCalledWith({
         data: [
            {
               distributionId: 'snapshot-db-id',
               recipientAddress: 'G_WALLET',
               amountXlm: 25,
            },
         ],
         skipDuplicates: true,
      });
      expect(mockPrisma.activity.create).toHaveBeenCalledTimes(1);
   });

   it('does not write duplicate snapshot claims when the unique event already exists', async () => {
      mockPrisma.dividendDistribution.create.mockRejectedValue({
         code: 'P2002',
      });

      await processDividendEvents(
         [
            {
               eventType: 'DIVIDEND_SNAPSHOT_CREATED',
               creatorId: 'key-1',
               totalDistributed: '25',
               holdersCount: 1,
               distributedAt: '2026-10-18T12:00:00.000Z',
               ledger: 200,
               txHash: 'tx-snapshot',
               eventIndex: 3,
            },
         ],
         { advanceCursor: false }
      );

      expect(mockPrisma.dividendClaim.createMany).not.toHaveBeenCalled();
      expect(mockPrisma.activity.create).not.toHaveBeenCalled();
   });

   it('marks only the matching wallet and snapshot claim as claimed', async () => {
      await processDividendEvents(
         [
            {
               eventType: 'DividendClaimed',
               keyId: 'key-1',
               wallet: 'G_WALLET',
               amountXlm: '12.5',
               snapshotId: 'chain-snapshot-1',
               claimedAt: '2026-10-18T13:00:00.000Z',
               ledger: 201,
               txHash: 'tx-claim',
               eventIndex: 0,
            },
         ],
         { advanceCursor: false }
      );

      expect(mockPrisma.dividendClaim.updateMany).toHaveBeenCalledWith({
         where: { id: 'claim-1', claimedAt: null },
         data: { claimedAt: new Date('2026-10-18T13:00:00.000Z') },
      });
      expect(mockPrisma.activity.create).toHaveBeenCalledTimes(1);
   });

   it('parses DividendSnapshotCreated contract topics', () => {
      expect(
         parseDividendContractLog({
            contractId: 'CONTRACT',
            topics: ['DividendSnapshotCreated', 'key-1'],
            data: {
               snapshotId: 'snapshot-1',
               totalDistributed: '20',
               claimWindowStart: '2026-10-18T12:00:00.000Z',
               claimWindowEnd: '2026-10-20T12:00:00.000Z',
            },
            ledger: 10,
            txHash: 'tx-1',
            eventIndex: 2,
         })
      ).toEqual(
         expect.objectContaining({
            eventType: 'DIVIDEND_SNAPSHOT_CREATED',
            creatorId: 'key-1',
            totalDistributed: '20',
            snapshotId: 'snapshot-1',
            eventIndex: 2,
         })
      );
   });
});
