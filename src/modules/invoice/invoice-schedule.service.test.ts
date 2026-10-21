import express from 'express';
import request from 'supertest';
import { invoiceScheduleRouter } from './invoice-schedule.routes';
import {
   buildInvoiceSchedule,
   computeInstalmentStatus,
   getInvoiceSchedule,
   getNextInvoiceInstalment,
} from './invoice-schedule.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheSetJson } from '../../utils/redis.utils';

const mockCache = new Map<string, string>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => {
      const raw = mockCache.get(key);
      return raw === undefined ? null : JSON.parse(raw);
   }),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => {
      mockCache.set(key, JSON.stringify(value));
   }),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      for (const k of keys) mockCache.delete(k);
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      invoice: {
         findUnique: jest.fn(),
      },
      instalmentPayment: {
         findMany: jest.fn(),
      },
   },
}));

const app = express();
app.use(express.json());
app.use('/invoices', invoiceScheduleRouter);

const NOW = new Date('2026-10-21T12:00:00.000Z');
const PAST_DUE = new Date('2026-10-15T12:00:00.000Z');
const FUTURE_DUE = new Date('2026-10-28T12:00:00.000Z');
const PAID_AT = new Date('2026-10-10T09:00:00.000Z');

beforeEach(() => {
   jest.clearAllMocks();
   mockCache.clear();
});

describe('invoice-schedule.service & routes (#1177)', () => {
   it('computes paid, overdue, and pending status accurately at request time', () => {
      expect(computeInstalmentStatus(PAST_DUE, PAID_AT, NOW)).toBe('paid');
      expect(computeInstalmentStatus(PAST_DUE, null, NOW)).toBe('overdue');
      expect(computeInstalmentStatus(FUTURE_DUE, null, NOW)).toBe('pending');
   });

   it('builds schedule with paid, overdue, and pending counts', () => {
      const schedule = buildInvoiceSchedule(
         'inv-1',
         [
            {
               id: 'inst-1',
               instalmentNumber: 1,
               amount: '100',
               dueDate: new Date('2026-10-10T00:00:00.000Z'),
               paidAt: PAID_AT,
               txHash: 'tx-1',
            },
            {
               id: 'inst-2',
               instalmentNumber: 2,
               amount: '100',
               dueDate: PAST_DUE,
               paidAt: null,
               txHash: null,
            },
            {
               id: 'inst-3',
               instalmentNumber: 3,
               amount: '100',
               dueDate: FUTURE_DUE,
               paidAt: null,
               txHash: null,
            },
         ],
         NOW
      );

      expect(schedule.paid_count).toBe(1);
      expect(schedule.overdue_count).toBe(1);
      expect(schedule.pending_count).toBe(1);
      expect(schedule.instalments.map(i => i.status)).toEqual([
         'paid',
         'overdue',
         'pending',
      ]);
   });

   it('returns schedule and next due instalment via REST and caches for 60s', async () => {
      (prisma.invoice.findUnique as jest.Mock).mockResolvedValue({
         id: 'inv-1',
      });
      (prisma.instalmentPayment.findMany as jest.Mock).mockResolvedValue([
         {
            id: 'inst-1',
            instalmentNumber: 1,
            amount: '250.0000000',
            dueDate: PAST_DUE,
            paidAt: PAID_AT,
            txHash: 'tx-1',
         },
         {
            id: 'inst-2',
            instalmentNumber: 2,
            amount: '250.0000000',
            dueDate: FUTURE_DUE,
            paidAt: null,
            txHash: null,
         },
      ]);

      const scheduleRes = await request(app).get('/invoices/inv-1/schedule');
      expect(scheduleRes.status).toBe(200);
      expect(scheduleRes.body.data.instalments).toHaveLength(2);
      expect(cacheSetJson).toHaveBeenCalledWith(
         'invoice:schedule:inv-1',
         expect.any(Object),
         60
      );

      const nextRes = await request(app).get('/invoices/inv-1/schedule/next');
      expect(nextRes.status).toBe(200);
      expect(nextRes.body.data.instalment_number).toBe(2);
      expect(nextRes.body.data.next_instalment.instalment_number).toBe(2);
   });

   it('returns 404 when invoice does not exist', async () => {
      (prisma.invoice.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.instalmentPayment.findMany as jest.Mock).mockResolvedValue([]);

      expect(await getInvoiceSchedule('unknown')).toBeNull();
      expect(await getNextInvoiceInstalment('unknown')).toBeNull();

      const res = await request(app).get('/invoices/unknown/schedule');
      expect(res.status).toBe(404);
   });
});
