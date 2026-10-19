// src/modules/indexer/key-curve-update-indexer.service.test.ts
import {
   processCurveUpdateEvents,
   isCurveUpdateEvent,
   parseDate,
} from './key-curve-update-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      curveUpdate: {
         upsert: jest.fn(),
         findMany: jest.fn(),
      },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

describe('key-curve-update-indexer.service', () => {
   const prismaMock = prisma as unknown as {
      curveUpdate: {
         upsert: jest.Mock;
         findMany: jest.Mock;
      };
   };

   beforeEach(() => {
      jest.clearAllMocks();
      prismaMock.curveUpdate.upsert.mockResolvedValue({});
   });

   describe('isCurveUpdateEvent', () => {
      it('recognizes CurveUpdateProposed and CurveUpdateExecuted events', () => {
         expect(
            isCurveUpdateEvent({
               eventType: 'CurveUpdateProposed',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(true);
         expect(
            isCurveUpdateEvent({
               eventType: 'CURVE_UPDATE_PROPOSED',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(true);
         expect(
            isCurveUpdateEvent({
               eventType: 'CurveUpdateExecuted',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(true);
         expect(
            isCurveUpdateEvent({
               eventType: 'CURVE_UPDATE_EXECUTED',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(true);
         expect(
            isCurveUpdateEvent({
               eventType: 'CurveUpdateCancelled',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(true);
         expect(
            isCurveUpdateEvent({
               eventType: 'OTHER_EVENT',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(false);
      });
   });

   describe('parseDate', () => {
      it('handles null / undefined / empty', () => {
         expect(parseDate(null)).toBeNull();
         expect(parseDate(undefined)).toBeNull();
         expect(parseDate('')).toBeNull();
      });

      it('handles Date object', () => {
         const now = new Date();
         expect(parseDate(now)).toEqual(now);
      });

      it('handles epoch seconds (< 1e12)', () => {
         const sec = 1792300000;
         expect(parseDate(sec)?.getTime()).toBe(sec * 1000);
      });

      it('handles epoch milliseconds (>= 1e12)', () => {
         const ms = 1792300000000;
         expect(parseDate(ms)?.getTime()).toBe(ms);
      });

      it('handles ISO string', () => {
         const iso = '2026-11-01T12:00:00.000Z';
         expect(parseDate(iso)?.toISOString()).toBe(iso);
      });
   });

   describe('processCurveUpdateEvents', () => {
      it('indexes CurveUpdateProposed into curve_updates table and invalidates cache', async () => {
         const event = {
            eventType: 'CurveUpdateProposed',
            keyId: 'key-100',
            proposalId: 'prop-1',
            proposedParams: { a: '10', b: '20', feeBps: 50 },
            eta: '2026-11-01T00:00:00.000Z',
            proposer: 'GPROPOSER1',
            ledger: 2000,
            txHash: 'tx-prop-1',
            eventIndex: 0,
         };

         await processCurveUpdateEvents([event]);

         expect(prismaMock.curveUpdate.upsert).toHaveBeenCalledTimes(1);
         expect(prismaMock.curveUpdate.upsert).toHaveBeenCalledWith({
            where: {
               keyId_proposalId: {
                  keyId: 'key-100',
                  proposalId: 'prop-1',
               },
            },
            create: {
               keyId: 'key-100',
               proposalId: 'prop-1',
               eventType: 'CurveUpdateProposed',
               status: 'pending',
               outcome: null,
               proposedParams: { a: '10', b: '20', feeBps: 50 },
               eta: new Date('2026-11-01T00:00:00.000Z'),
               proposer: 'GPROPOSER1',
               executor: null,
               executedAt: null,
               ledger: 2000,
               txHash: 'tx-prop-1',
               eventIndex: 0,
            },
            update: expect.objectContaining({
               status: 'pending',
               proposedParams: { a: '10', b: '20', feeBps: 50 },
            }),
         });
         expect(cacheInvalidate).toHaveBeenCalledWith(
            'key:curve-updates:pending:key-100',
            'key:curve-updates:history:key-100'
         );
      });

      it('indexes CurveUpdateExecuted into curve_updates table and marks completed', async () => {
         const event = {
            eventType: 'CurveUpdateExecuted',
            creatorId: 'key-100',
            proposalId: 'prop-1',
            executedBy: 'GADMIN1',
            executedAt: '2026-11-01T01:00:00.000Z',
            ledger: 2050,
            txHash: 'tx-exec-1',
            eventIndex: 1,
         };

         await processCurveUpdateEvents([event]);

         expect(prismaMock.curveUpdate.upsert).toHaveBeenCalledTimes(1);
         expect(prismaMock.curveUpdate.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
               where: {
                  keyId_proposalId: {
                     keyId: 'key-100',
                     proposalId: 'prop-1',
                  },
               },
               update: expect.objectContaining({
                  status: 'completed',
                  outcome: 'executed',
                  executor: 'GADMIN1',
               }),
            })
         );
         expect(cacheInvalidate).toHaveBeenCalledWith(
            'key:curve-updates:pending:key-100',
            'key:curve-updates:history:key-100'
         );
      });

      it('indexes CurveUpdateCancelled and marks cancelled', async () => {
         const event = {
            eventType: 'CurveUpdateCancelled',
            keyId: 'key-100',
            proposalId: 'prop-2',
            ledger: 2100,
            txHash: 'tx-cancel-1',
            eventIndex: 0,
         };

         await processCurveUpdateEvents([event]);

         expect(prismaMock.curveUpdate.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
               create: expect.objectContaining({
                  status: 'cancelled',
                  outcome: 'cancelled',
               }),
            })
         );
      });

      it('skips events missing keyId', async () => {
         const event = {
            eventType: 'CurveUpdateProposed',
            ledger: 2200,
            txHash: 'tx-nokey',
            eventIndex: 0,
         };

         await processCurveUpdateEvents([event]);

         expect(prismaMock.curveUpdate.upsert).not.toHaveBeenCalled();
      });
   });
});
