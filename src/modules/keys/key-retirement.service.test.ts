// src/modules/keys/key-retirement.service.test.ts
import {
   getKeyRetirementStatus,
   getKeyRetirementHistory,
} from './key-retirement.service';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyRetirement: {
         findFirst: jest.fn(),
         findMany: jest.fn(),
      },
   },
}));

describe('key-retirement.service', () => {
   const prismaMock = prisma as unknown as {
      keyRetirement: {
         findFirst: jest.Mock;
         findMany: jest.Mock;
      };
   };

   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('getKeyRetirementStatus', () => {
      it('returns status: "none" for keys with no retirement record', async () => {
         prismaMock.keyRetirement.findFirst.mockResolvedValue(null);

         const result = await getKeyRetirementStatus('unretired-key');

         expect(result.status).toBe('none');
         expect(result.key_id).toBe('unretired-key');
         expect(result.buyback_price).toBeNull();
         expect(result.notice_expiry).toBeNull();
         expect(result.notice_countdown).toBeNull();
         expect(result.notice_countdown_seconds).toBeNull();
         expect(result.reason).toBeNull();
      });

      it('returns status: "proposed" with accurate buyback_price and dynamically computed notice countdown', async () => {
         const now = Date.now();
         const futureExpiry = new Date(now + 120 * 1000); // 120 seconds in future

         prismaMock.keyRetirement.findFirst.mockResolvedValue({
            id: 'ret-1',
            keyId: 'key-test',
            eventType: 'RetirementProposed',
            status: 'proposed',
            buybackPrice: '10.50',
            noticeExpiry: futureExpiry,
            reason: 'Creator winding down',
            actor: 'GACTOR1',
            ledger: 500,
            txHash: 'tx-500',
            eventIndex: 0,
            createdAt: new Date('2026-10-19T00:00:00.000Z'),
         });

         const result = await getKeyRetirementStatus('key-test');

         expect(result.status).toBe('proposed');
         expect(result.key_id).toBe('key-test');
         expect(result.buyback_price).toBe('10.50');
         expect(result.notice_expiry).toBe(futureExpiry.toISOString());
         expect(result.reason).toBe('Creator winding down');
         expect(result.notice_countdown).toBeGreaterThanOrEqual(119);
         expect(result.notice_countdown).toBeLessThanOrEqual(121);
         expect(result.notice_countdown_seconds).toBe(result.notice_countdown);
      });

      it('clamps countdown to 0 when notice expiry is in the past', async () => {
         const pastExpiry = new Date(Date.now() - 60 * 1000);

         prismaMock.keyRetirement.findFirst.mockResolvedValue({
            id: 'ret-2',
            keyId: 'key-past',
            eventType: 'RetirementProposed',
            status: 'proposed',
            buybackPrice: '8.00',
            noticeExpiry: pastExpiry,
            reason: null,
            actor: null,
            ledger: 600,
            txHash: 'tx-600',
            eventIndex: 0,
            createdAt: new Date(),
         });

         const result = await getKeyRetirementStatus('key-past');

         expect(result.status).toBe('proposed');
         expect(result.notice_countdown).toBe(0);
         expect(result.notice_countdown_seconds).toBe(0);
      });

      it('returns status: "retired" when execution occurred', async () => {
         prismaMock.keyRetirement.findFirst.mockResolvedValue({
            id: 'ret-3',
            keyId: 'key-retired',
            eventType: 'RetirementExecuted',
            status: 'retired',
            buybackPrice: '10.50',
            noticeExpiry: null,
            reason: 'Fully retired',
            actor: 'GADMIN',
            ledger: 700,
            txHash: 'tx-700',
            eventIndex: 0,
            createdAt: new Date(),
         });

         const result = await getKeyRetirementStatus('key-retired');

         expect(result.status).toBe('retired');
         expect(result.buyback_price).toBe('10.50');
         expect(result.notice_countdown).toBeNull();
      });

      it('returns status: "deprecated" when deprecation occurred', async () => {
         prismaMock.keyRetirement.findFirst.mockResolvedValue({
            id: 'ret-4',
            keyId: 'key-deprecated',
            eventType: 'DeprecationExecuted',
            status: 'deprecated',
            buybackPrice: '3.00',
            noticeExpiry: null,
            reason: 'Migrated to v2',
            actor: 'GADMIN',
            ledger: 800,
            txHash: 'tx-800',
            eventIndex: 0,
            createdAt: new Date(),
         });

         const result = await getKeyRetirementStatus('key-deprecated');

         expect(result.status).toBe('deprecated');
         expect(result.buyback_price).toBe('3.00');
         expect(result.reason).toBe('Migrated to v2');
      });
   });

   describe('getKeyRetirementHistory', () => {
      it('returns full retirement event log ordered chronologically', async () => {
         prismaMock.keyRetirement.findMany.mockResolvedValue([
            {
               id: 'ret-prop',
               keyId: 'key-hist',
               eventType: 'RetirementProposed',
               status: 'proposed',
               buybackPrice: '12.0',
               noticeExpiry: new Date('2026-11-01T00:00:00.000Z'),
               reason: 'Proposed by creator',
               actor: 'GCREATOR',
               ledger: 100,
               txHash: 'tx-100',
               eventIndex: 0,
               createdAt: new Date('2026-10-18T10:00:00.000Z'),
            },
            {
               id: 'ret-exec',
               keyId: 'key-hist',
               eventType: 'RetirementExecuted',
               status: 'retired',
               buybackPrice: '12.0',
               noticeExpiry: new Date('2026-11-01T00:00:00.000Z'),
               reason: 'Executed by admin',
               actor: 'GADMIN',
               ledger: 200,
               txHash: 'tx-200',
               eventIndex: 0,
               createdAt: new Date('2026-10-19T10:00:00.000Z'),
            },
         ]);

         const history = await getKeyRetirementHistory('key-hist');

         expect(prismaMock.keyRetirement.findMany).toHaveBeenCalledWith({
            where: { keyId: 'key-hist' },
            orderBy: [
               { createdAt: 'asc' },
               { ledger: 'asc' },
               { eventIndex: 'asc' },
            ],
         });

         expect(history).toHaveLength(2);
         expect(history[0]).toMatchObject({
            id: 'ret-prop',
            key_id: 'key-hist',
            event_type: 'RetirementProposed',
            status: 'proposed',
            buyback_price: '12.0',
            reason: 'Proposed by creator',
            actor: 'GCREATOR',
            ledger: 100,
            tx_hash: 'tx-100',
            event_index: 0,
         });
         expect(history[1]).toMatchObject({
            id: 'ret-exec',
            key_id: 'key-hist',
            event_type: 'RetirementExecuted',
            status: 'retired',
            buyback_price: '12.0',
            reason: 'Executed by admin',
            actor: 'GADMIN',
            ledger: 200,
            tx_hash: 'tx-200',
            event_index: 0,
         });
      });

      it('returns empty array when no events recorded', async () => {
         prismaMock.keyRetirement.findMany.mockResolvedValue([]);

         const history = await getKeyRetirementHistory('empty-key');
         expect(history).toEqual([]);
      });
   });
});
