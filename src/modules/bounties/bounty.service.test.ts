// src/modules/bounties/bounty.service.test.ts
import {
   BountyService,
   BountyNotFoundError,
   computeBountyStatus,
   computeReclaimableAmount,
} from './bounty.service';
import { processBountyEvents } from '../indexer/bounty-indexer.service';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      bounty: {
         findMany: jest.fn(),
         findFirst: jest.fn(),
         findUnique: jest.fn(),
         upsert: jest.fn(),
         update: jest.fn(),
      },
      bountySubmission: {
         upsert: jest.fn(),
      },
      bountyAward: {
         findUnique: jest.fn(),
         create: jest.fn(),
      },
      ledgerCheckpoint: {
         findFirst: jest.fn(),
      },
      $transaction: jest.fn(async ops => Promise.all(ops)),
   },
}));

describe('BountyService & Indexer (#1307)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('computeBountyStatus & computeReclaimableAmount', () => {
      const base = {
         reclaimedAtLedger: null,
         reclaimedAmount: 0n,
         winnersCount: 0,
         maxWinners: 2,
         awardedAmount: 0n,
         rewardAmount: 10_000_000n,
         deadlineLedger: 500,
      };

      it('computes open, expired, completed, and reclaimed statuses', () => {
         expect(computeBountyStatus(base, 400)).toBe('open');
         expect(computeBountyStatus(base, 501)).toBe('expired');
         expect(computeBountyStatus({ ...base, winnersCount: 2 }, 400)).toBe(
            'completed'
         );
         expect(computeBountyStatus({ ...base, reclaimedAtLedger: 510 }, 520)).toBe(
            'reclaimed'
         );
      });

      it('computes reclaimable amount only when expired', () => {
         expect(computeReclaimableAmount(base, 400)).toBe(0n);
         expect(
            computeReclaimableAmount(
               { ...base, awardedAmount: 3_000_000n },
               501
            )
         ).toBe(7_000_000n);
         expect(
            computeReclaimableAmount({ ...base, reclaimedAtLedger: 510 }, 520)
         ).toBe(0n);
      });
   });

   describe('BountyService queries', () => {
      it('lists bounties with cursor pagination and status filtering', async () => {
         (prisma.ledgerCheckpoint.findFirst as jest.Mock).mockResolvedValue({
            ledgerSequence: 100,
         });
         (prisma.bounty.findMany as jest.Mock).mockResolvedValue([
            {
               id: 'b1',
               onChainId: 'on1',
               keyId: 'k1',
               creatorHandle: 'alice',
               creatorWallet: 'GALICE',
               title: 'Build SDK',
               description: null,
               rewardAmount: 50_000_000n,
               awardedAmount: 0n,
               reclaimedAmount: 0n,
               maxWinners: 1,
               winnersCount: 0,
               deadlineLedger: 200,
               reclaimedAtLedger: null,
               createdAt: new Date('2026-11-24T00:00:00Z'),
            },
         ]);

         const service = new BountyService();
         const res = await service.listBounties({ keyId: 'k1', status: 'open' });
         expect(res.items).toHaveLength(1);
         expect(res.items[0].status).toBe('open');
         expect(res.hasMore).toBe(false);
      });

      it('returns detail with submissions, awards, and winnersRemaining', async () => {
         (prisma.ledgerCheckpoint.findFirst as jest.Mock).mockResolvedValue({
            ledgerSequence: 100,
         });
         (prisma.bounty.findFirst as jest.Mock).mockResolvedValue({
            id: 'b1',
            onChainId: 'on1',
            keyId: 'k1',
            creatorHandle: 'alice',
            creatorWallet: 'GALICE',
            title: 'Build SDK',
            description: 'desc',
            rewardAmount: 50_000_000n,
            awardedAmount: 25_000_000n,
            reclaimedAmount: 0n,
            maxWinners: 2,
            winnersCount: 1,
            deadlineLedger: 200,
            reclaimedAtLedger: null,
            createdAt: new Date('2026-11-24T00:00:00Z'),
            submissions: [
               {
                  id: 's1',
                  submissionId: 'sub-1',
                  submitter: 'GBOB',
                  contentUri: 'ipfs://abc',
                  ledger: 90,
                  txHash: 'tx1',
                  createdAt: new Date('2026-11-24T00:00:00Z'),
               },
            ],
            awards: [
               {
                  id: 'a1',
                  submissionId: 'sub-1',
                  winner: 'GBOB',
                  amount: 25_000_000n,
                  ledger: 95,
                  txHash: 'tx2',
                  createdAt: new Date('2026-11-24T00:00:00Z'),
               },
            ],
         });

         const service = new BountyService();
         const detail = await service.getBountyDetail('b1');
         expect(detail.winnersRemaining).toBe(1);
         expect(detail.submissions).toHaveLength(1);
         expect(detail.awards).toHaveLength(1);
      });

      it('throws BountyNotFoundError for unknown bounty', async () => {
         (prisma.bounty.findFirst as jest.Mock).mockResolvedValue(null);
         const service = new BountyService();
         await expect(service.getBountyDetail('missing')).rejects.toThrow(
            BountyNotFoundError
         );
      });

      it('lists creator bounties with reclaimable totals', async () => {
         (prisma.ledgerCheckpoint.findFirst as jest.Mock).mockResolvedValue({
            ledgerSequence: 500,
         });
         (prisma.bounty.findMany as jest.Mock).mockResolvedValue([
            {
               id: 'b1',
               onChainId: 'on1',
               keyId: 'k1',
               creatorHandle: 'alice',
               creatorWallet: 'GALICE',
               title: 'Expired Bounty',
               description: null,
               rewardAmount: 50_000_000n,
               awardedAmount: 10_000_000n,
               reclaimedAmount: 0n,
               maxWinners: 2,
               winnersCount: 1,
               deadlineLedger: 200,
               reclaimedAtLedger: null,
               createdAt: new Date('2026-11-24T00:00:00Z'),
            },
         ]);

         const service = new BountyService();
         const res = await service.listCreatorBounties('alice');
         expect(res.totalReclaimableAmount).toBe('40000000');
         expect(res.items[0].reclaimableAmount).toBe('40000000');
      });
   });

   describe('bounty-indexer', () => {
      it('handles bounty_posted and bounty_awarded idempotently', async () => {
         await processBountyEvents([
            {
               eventType: 'bounty_posted',
               txHash: 'tx1',
               eventIndex: 0,
               ledger: 100,
               bountyId: 'on1',
               keyId: 'k1',
               creatorHandle: 'alice',
               creatorWallet: 'GALICE',
               title: 'Bounty 1',
               rewardAmount: '50000000',
               maxWinners: 2,
               deadlineLedger: 300,
            } as any,
         ]);
         expect(prisma.bounty.upsert).toHaveBeenCalledTimes(1);

         (prisma.bounty.findUnique as jest.Mock).mockResolvedValue({
            id: 'b1',
            onChainId: 'on1',
            awardedAmount: 0n,
            winnersCount: 0,
         });
         (prisma.bountyAward.findUnique as jest.Mock).mockResolvedValue(null);

         await processBountyEvents([
            {
               eventType: 'bounty_awarded',
               txHash: 'tx2',
               eventIndex: 0,
               ledger: 120,
               bountyId: 'on1',
               winner: 'GBOB',
               amount: '25000000',
            } as any,
         ]);
         expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      });
   });
});
