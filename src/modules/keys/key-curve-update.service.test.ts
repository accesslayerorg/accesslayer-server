// src/modules/keys/key-curve-update.service.test.ts
import {
   getPendingCurveUpdates,
   getCurveUpdateHistory,
} from './key-curve-update.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      curveUpdate: {
         findMany: jest.fn(),
      },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
   cacheInvalidate: jest.fn(),
}));

describe('key-curve-update.service', () => {
   const prismaMock = prisma as unknown as {
      curveUpdate: {
         findMany: jest.Mock;
      };
   };
   const mockCacheGetJson = cacheGetJson as jest.Mock;
   const mockCacheSetJson = cacheSetJson as jest.Mock;

   beforeEach(() => {
      jest.clearAllMocks();
      mockCacheGetJson.mockResolvedValue(null);
      mockCacheSetJson.mockResolvedValue(undefined);
   });

   describe('getPendingCurveUpdates', () => {
      it('returns pending proposals with eta, proposed params, and dynamic countdown', async () => {
         const now = Date.now();
         const futureEta = new Date(now + 60 * 1000); // 60 seconds from now

         prismaMock.curveUpdate.findMany.mockResolvedValue([
            {
               id: 'cu-1',
               keyId: 'key-test',
               proposalId: 'prop-1',
               status: 'pending',
               proposedParams: { targetReserve: '1000' },
               eta: futureEta,
               proposer: 'GPROPOSER',
               ledger: 500,
               txHash: 'tx-500',
               createdAt: new Date('2026-10-19T00:00:00.000Z'),
            },
         ]);

         const result = await getPendingCurveUpdates('key-test');

         expect(prismaMock.curveUpdate.findMany).toHaveBeenCalledWith({
            where: { keyId: 'key-test', status: 'pending' },
            orderBy: [{ eta: 'asc' }, { createdAt: 'asc' }],
         });

         expect(result).toHaveLength(1);
         expect(result[0]).toMatchObject({
            proposal_id: 'prop-1',
            key_id: 'key-test',
            status: 'pending',
            proposed_params: { targetReserve: '1000' },
            eta: futureEta.toISOString(),
            proposer: 'GPROPOSER',
         });
         expect(result[0].eta_countdown).toBeGreaterThanOrEqual(58);
         expect(result[0].eta_countdown).toBeLessThanOrEqual(61);
         expect(result[0].eta_countdown_seconds).toBe(result[0].eta_countdown);

         expect(mockCacheSetJson).toHaveBeenCalledWith(
            'key:curve-updates:pending:key-test',
            expect.any(Array),
            60
         );
      });

      it('recomputes countdown dynamically even on cache hit', async () => {
         const now = Date.now();
         const futureEta = new Date(now + 45 * 1000).toISOString();

         mockCacheGetJson.mockResolvedValue([
            {
               proposal_id: 'prop-cached',
               key_id: 'key-test',
               status: 'pending',
               proposed_params: { feeRate: 30 },
               eta: futureEta,
               eta_countdown: 999, // Stale cached countdown
               proposer: 'GCACHED',
            },
         ]);

         const result = await getPendingCurveUpdates('key-test');

         expect(prismaMock.curveUpdate.findMany).not.toHaveBeenCalled();
         expect(result[0].eta_countdown).toBeGreaterThanOrEqual(43);
         expect(result[0].eta_countdown).toBeLessThanOrEqual(46);
      });

      it('clamps countdown to 0 when ETA is in the past', async () => {
         const pastEta = new Date(Date.now() - 10 * 1000);

         prismaMock.curveUpdate.findMany.mockResolvedValue([
            {
               id: 'cu-past',
               keyId: 'key-past',
               proposalId: 'prop-past',
               status: 'pending',
               proposedParams: null,
               eta: pastEta,
               proposer: null,
               ledger: 510,
               txHash: 'tx-510',
               createdAt: new Date(),
            },
         ]);

         const result = await getPendingCurveUpdates('key-past');

         expect(result[0].eta_countdown).toBe(0);
         expect(result[0].eta_countdown_seconds).toBe(0);
      });
   });

   describe('getCurveUpdateHistory', () => {
      it('returns completed and cancelled updates with outcomes', async () => {
         prismaMock.curveUpdate.findMany.mockResolvedValue([
            {
               id: 'cu-exec',
               keyId: 'key-hist',
               proposalId: 'prop-exec',
               status: 'completed',
               outcome: 'executed',
               proposedParams: { paramA: 1 },
               eta: new Date('2026-10-18T10:00:00.000Z'),
               proposer: 'GPROP',
               executor: 'GEXEC',
               executedAt: new Date('2026-10-18T12:00:00.000Z'),
               ledger: 600,
               txHash: 'tx-600',
               createdAt: new Date('2026-10-18T09:00:00.000Z'),
               updatedAt: new Date('2026-10-18T12:00:00.000Z'),
            },
            {
               id: 'cu-cancel',
               keyId: 'key-hist',
               proposalId: 'prop-cancel',
               status: 'cancelled',
               outcome: 'cancelled',
               proposedParams: { paramB: 2 },
               eta: new Date('2026-10-17T10:00:00.000Z'),
               proposer: 'GPROP',
               executor: null,
               executedAt: null,
               ledger: 550,
               txHash: 'tx-550',
               createdAt: new Date('2026-10-17T09:00:00.000Z'),
               updatedAt: new Date('2026-10-17T10:30:00.000Z'),
            },
         ]);

         const result = await getCurveUpdateHistory('key-hist');

         expect(prismaMock.curveUpdate.findMany).toHaveBeenCalledWith({
            where: {
               keyId: 'key-hist',
               status: { in: ['completed', 'cancelled'] },
            },
            orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
         });

         expect(result).toHaveLength(2);
         expect(result[0]).toMatchObject({
            proposal_id: 'prop-exec',
            status: 'completed',
            outcome: 'executed',
            executor: 'GEXEC',
         });
         expect(result[1]).toMatchObject({
            proposal_id: 'prop-cancel',
            status: 'cancelled',
            outcome: 'cancelled',
         });
         expect(mockCacheSetJson).toHaveBeenCalledWith(
            'key:curve-updates:history:key-hist',
            expect.any(Array),
            60
         );
      });

      it('returns cached history when available', async () => {
         mockCacheGetJson.mockResolvedValue([
            {
               proposal_id: 'prop-cached-hist',
               status: 'completed',
               outcome: 'executed',
            },
         ]);

         const result = await getCurveUpdateHistory('key-hist');

         expect(prismaMock.curveUpdate.findMany).not.toHaveBeenCalled();
         expect(result).toHaveLength(1);
         expect(result[0].proposal_id).toBe('prop-cached-hist');
      });
   });
});
