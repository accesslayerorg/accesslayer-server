// src/modules/governance/conviction.service.test.ts
import {
   ConvictionService,
   CONVICTION_CACHE_TTL_SECONDS,
   ConvictionProposalNotFoundError,
   stepConviction,
   projectCrossingLedger,
} from './conviction.service';
import { processConvictionEvents } from '../indexer/conviction-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      convictionSnapshot: {
         findMany: jest.fn(),
         findUnique: jest.fn(),
         findFirst: jest.fn(),
         create: jest.fn(),
      },
      convictionStake: {
         findMany: jest.fn(),
         findUnique: jest.fn(),
         upsert: jest.fn(),
         update: jest.fn(),
         updateMany: jest.fn(),
      },
      ragequitExit: {
         findMany: jest.fn(),
         upsert: jest.fn(),
      },
      governanceProposal: {
         findFirst: jest.fn(),
      },
      ledgerCheckpoint: {
         findFirst: jest.fn(),
      },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

describe('ConvictionService & Indexer (#1306)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (cacheGetJson as jest.Mock).mockResolvedValue(null);
   });

   describe('decay math', () => {
      it('replays discrete decay identical to contract', () => {
         // C_0 = 0, S = 1000, alpha = 0.9:
         // step 1: 0 + 1000 = 1000
         // step 2: 900 + 1000 = 1900
         // step 3: 1710 + 1000 = 2710
         expect(stepConviction(0n, 1000n, 3, 9000n)).toBe(2710n);
      });

      it('projects crossing ledger or returns null when steady-state < threshold', () => {
         // S = 1000, alpha = 0.9 => steady state max = 10000
         expect(projectCrossingLedger(0n, 1000n, 15000n, 100, 9000n)).toBeNull();
         expect(projectCrossingLedger(0n, 1000n, 2500n, 100, 9000n)).toBe(103);
      });
   });

   describe('progress()', () => {
      it('computes progress, caches for 10s, and includes optional wallet stake', async () => {
         (prisma.convictionSnapshot.findMany as jest.Mock).mockResolvedValue([
            {
               proposalId: 'prop-1',
               ledger: 100,
               totalStaked: 1000n,
               conviction: 0n,
               threshold: 5000n,
               executed: false,
            },
         ]);
         (prisma.convictionStake.findMany as jest.Mock).mockResolvedValue([
            { wallet: 'GWALLET1', amount: 1000n, isActive: true, stakedAtLedger: 100 },
         ]);
         (prisma.governanceProposal.findFirst as jest.Mock).mockResolvedValue(null);
         (prisma.ledgerCheckpoint.findFirst as jest.Mock).mockResolvedValue({
            ledgerSequence: 103,
         });
         (prisma.convictionStake.findUnique as jest.Mock).mockResolvedValue({
            wallet: 'GWALLET1',
            amount: 1000n,
            isActive: true,
            stakedAtLedger: 100,
         });

         const service = new ConvictionService();
         const result = await service.progress('prop-1', { wallet: 'GWALLET1' });

         expect(result.proposalId).toBe('prop-1');
         expect(result.conviction).toBe('2710');
         expect(result.threshold).toBe('5000');
         expect(result.projectedCrossingLedger).toBeGreaterThan(103);
         expect(result.walletStake?.amount).toBe('1000');
         expect(cacheSetJson).toHaveBeenCalledWith(
            'conviction:progress:prop-1:GWALLET1',
            result,
            CONVICTION_CACHE_TTL_SECONDS
         );
      });

      it('throws ConvictionProposalNotFoundError when no data exists', async () => {
         (prisma.convictionSnapshot.findMany as jest.Mock).mockResolvedValue([]);
         (prisma.convictionStake.findMany as jest.Mock).mockResolvedValue([]);
         (prisma.governanceProposal.findFirst as jest.Mock).mockResolvedValue(null);

         const service = new ConvictionService();
         await expect(service.progress('missing')).rejects.toThrow(
            ConvictionProposalNotFoundError
         );
      });
   });

   describe('getRagequitStatus()', () => {
      it('returns window status, total exits vs cap, and wallet eligibility', async () => {
         (prisma.governanceProposal.findFirst as jest.Mock).mockResolvedValue({
            proposalId: 'prop-1',
            snapshotLedger: 90,
            snapshotTotalWeight: '10000',
            executedAt: new Date(),
            status: 'executed',
         });
         (prisma.convictionSnapshot.findFirst as jest.Mock).mockResolvedValue({
            proposalId: 'prop-1',
            ledger: 100,
            totalStaked: 10000n,
            executed: true,
         });
         (prisma.ragequitExit.findMany as jest.Mock).mockResolvedValue([
            { wallet: 'GOTHER', amount: 500n },
         ]);
         (prisma.ledgerCheckpoint.findFirst as jest.Mock).mockResolvedValue({
            ledgerSequence: 150,
         });
         (prisma.convictionStake.findUnique as jest.Mock).mockResolvedValue({
            wallet: 'GWALLET1',
            amount: 1000n,
            isActive: true,
         });

         const service = new ConvictionService();
         const res = await service.getRagequitStatus('prop-1', { wallet: 'GWALLET1' });

         expect(res.windowOpen).toBe(true);
         expect(res.totalExits).toBe('500');
         expect(res.exitCap).toBe('2000');
         expect(res.remainingCap).toBe('1500');
         expect(res.eligible).toBe(true);
      });
   });

   describe('conviction-indexer', () => {
      it('processes staked event idempotently and invalidates cache', async () => {
         (prisma.convictionSnapshot.findUnique as jest.Mock).mockResolvedValue(null);
         (prisma.convictionStake.findUnique as jest.Mock).mockResolvedValue(null);
         (prisma.convictionStake.findMany as jest.Mock).mockResolvedValue([
            { amount: 500n },
         ]);

         await processConvictionEvents([
            {
               eventType: 'staked',
               txHash: 'tx1',
               eventIndex: 0,
               ledger: 100,
               proposalId: 'prop-1',
               keyId: 'key-1',
               wallet: 'GWALLET1',
               amount: '500',
               threshold: '5000',
            } as any,
         ]);

         expect(prisma.convictionStake.upsert).toHaveBeenCalledTimes(1);
         expect(prisma.convictionSnapshot.create).toHaveBeenCalledTimes(1);
         expect(cacheInvalidate).toHaveBeenCalledWith('conviction:progress:prop-1:*');
         expect(cacheInvalidate).toHaveBeenCalledWith('conviction:ragequit:prop-1:*');
      });
   });
});
