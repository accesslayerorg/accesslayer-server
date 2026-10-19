// src/modules/indexer/key-retirement-indexer.service.test.ts
import {
   processKeyRetirementEvents,
   isKeyRetirementEvent,
   resolveRetirementStatus,
   parseNoticeExpiry,
} from './key-retirement-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyRetirement: {
         upsert: jest.fn(),
         findFirst: jest.fn(),
         findMany: jest.fn(),
      },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

describe('key-retirement-indexer.service', () => {
   const prismaMock = prisma as unknown as {
      keyRetirement: {
         upsert: jest.Mock;
         findFirst: jest.Mock;
         findMany: jest.Mock;
      };
   };

   beforeEach(() => {
      jest.clearAllMocks();
      prismaMock.keyRetirement.upsert.mockResolvedValue({});
   });

   describe('isKeyRetirementEvent', () => {
      it('recognizes all three event types in mixed casing', () => {
         expect(
            isKeyRetirementEvent({
               eventType: 'RetirementProposed',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(true);
         expect(
            isKeyRetirementEvent({
               eventType: 'RETIREMENT_PROPOSED',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(true);
         expect(
            isKeyRetirementEvent({
               eventType: 'RetirementExecuted',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(true);
         expect(
            isKeyRetirementEvent({
               eventType: 'DEPRECATION_EXECUTED',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(true);
         expect(
            isKeyRetirementEvent({
               eventType: 'OTHER_EVENT',
               ledger: 1,
               txHash: 'tx1',
               eventIndex: 0,
            })
         ).toBe(false);
      });
   });

   describe('resolveRetirementStatus', () => {
      it('maps event types to expected status strings', () => {
         expect(resolveRetirementStatus('RetirementProposed')).toBe('proposed');
         expect(resolveRetirementStatus('RETIREMENT_PROPOSED')).toBe('proposed');
         expect(resolveRetirementStatus('RetirementExecuted')).toBe('retired');
         expect(resolveRetirementStatus('RETIREMENT_EXECUTED')).toBe('retired');
         expect(resolveRetirementStatus('DeprecationExecuted')).toBe(
            'deprecated'
         );
         expect(resolveRetirementStatus('DEPRECATION_EXECUTED')).toBe(
            'deprecated'
         );
      });
   });

   describe('parseNoticeExpiry', () => {
      it('handles null / undefined / empty', () => {
         expect(parseNoticeExpiry(null)).toBeNull();
         expect(parseNoticeExpiry(undefined)).toBeNull();
         expect(parseNoticeExpiry('')).toBeNull();
      });

      it('handles Date instances', () => {
         const now = new Date();
         expect(parseNoticeExpiry(now)).toEqual(now);
      });

      it('handles numeric epoch seconds (< 1e12)', () => {
         const sec = 1792300000;
         const d = parseNoticeExpiry(sec);
         expect(d?.getTime()).toBe(sec * 1000);
      });

      it('handles numeric epoch milliseconds (>= 1e12)', () => {
         const ms = 1792300000000;
         const d = parseNoticeExpiry(ms);
         expect(d?.getTime()).toBe(ms);
      });

      it('handles string epoch seconds', () => {
         const sec = '1792300000';
         const d = parseNoticeExpiry(sec);
         expect(d?.getTime()).toBe(1792300000 * 1000);
      });

      it('handles ISO string', () => {
         const iso = '2026-12-31T23:59:59.000Z';
         const d = parseNoticeExpiry(iso);
         expect(d?.toISOString()).toBe(iso);
      });
   });

   describe('processKeyRetirementEvents', () => {
      it('indexes RetirementProposed event into key_retirement table', async () => {
         const event = {
            eventType: 'RetirementProposed',
            keyId: 'key-123',
            buybackPrice: '15.5',
            noticeExpiry: '2026-11-01T00:00:00.000Z',
            reason: 'Creator voluntary retirement',
            proposedBy: 'GAUTH1',
            ledger: 1000,
            txHash: 'tx-prop-1',
            eventIndex: 0,
         };

         await processKeyRetirementEvents([event]);

         expect(prismaMock.keyRetirement.upsert).toHaveBeenCalledTimes(1);
         expect(prismaMock.keyRetirement.upsert).toHaveBeenCalledWith({
            where: {
               txHash_eventIndex: {
                  txHash: 'tx-prop-1',
                  eventIndex: 0,
               },
            },
            create: {
               keyId: 'key-123',
               eventType: 'RetirementProposed',
               status: 'proposed',
               buybackPrice: '15.5',
               noticeExpiry: new Date('2026-11-01T00:00:00.000Z'),
               reason: 'Creator voluntary retirement',
               actor: 'GAUTH1',
               ledger: 1000,
               txHash: 'tx-prop-1',
               eventIndex: 0,
            },
            update: {
               status: 'proposed',
               buybackPrice: '15.5',
               noticeExpiry: new Date('2026-11-01T00:00:00.000Z'),
               reason: 'Creator voluntary retirement',
               actor: 'GAUTH1',
            },
         });
         expect(cacheInvalidate).toHaveBeenCalledWith(
            'key:retirement:key-123'
         );
      });

      it('indexes RetirementExecuted event into key_retirement table', async () => {
         const event = {
            eventType: 'RetirementExecuted',
            creatorId: 'key-123',
            buybackPriceXlm: '15.5',
            actor: 'GAUTH_ADMIN',
            ledger: 1050,
            txHash: 'tx-exec-1',
            eventIndex: 1,
         };

         await processKeyRetirementEvents([event]);

         expect(prismaMock.keyRetirement.upsert).toHaveBeenCalledTimes(1);
         expect(prismaMock.keyRetirement.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
               create: expect.objectContaining({
                  keyId: 'key-123',
                  eventType: 'RetirementExecuted',
                  status: 'retired',
                  buybackPrice: '15.5',
                  actor: 'GAUTH_ADMIN',
               }),
            })
         );
      });

      it('indexes DeprecationExecuted event into key_retirement table', async () => {
         const event = {
            eventType: 'DeprecationExecuted',
            key_id: 'key-999',
            buyback_price: '5.0',
            reason: 'Contract upgrade deprecation',
            executedBy: 'GAUTH_GOV',
            ledger: 1100,
            txHash: 'tx-deprecate-1',
            eventIndex: 0,
         };

         await processKeyRetirementEvents([event]);

         expect(prismaMock.keyRetirement.upsert).toHaveBeenCalledTimes(1);
         expect(prismaMock.keyRetirement.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
               create: expect.objectContaining({
                  keyId: 'key-999',
                  eventType: 'DeprecationExecuted',
                  status: 'deprecated',
                  buybackPrice: '5.0',
                  reason: 'Contract upgrade deprecation',
                  actor: 'GAUTH_GOV',
               }),
            })
         );
      });

      it('skips events missing keyId', async () => {
         const event = {
            eventType: 'RetirementProposed',
            ledger: 1200,
            txHash: 'tx-missing-key',
            eventIndex: 0,
         };

         await processKeyRetirementEvents([event]);

         expect(prismaMock.keyRetirement.upsert).not.toHaveBeenCalled();
      });

      it('ignores non-retirement events in batch', async () => {
         const event = {
            eventType: 'UNKNOWN_EVENT',
            keyId: 'key-1',
            ledger: 1200,
            txHash: 'tx-unknown',
            eventIndex: 0,
         };

         await processKeyRetirementEvents([event]);

         expect(prismaMock.keyRetirement.upsert).not.toHaveBeenCalled();
      });
   });
});
