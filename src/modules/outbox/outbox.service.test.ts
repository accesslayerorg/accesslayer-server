jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      outboxEvent: {
         findMany: jest.fn(),
      },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   OUTBOX_BULK_FETCH_LIMIT,
   OUTBOX_MAX_ATTEMPTS,
   OutboxService,
   priorityForOutboxType,
} from './outbox.service';

const findMany = prisma.outboxEvent.findMany as unknown as jest.Mock;

/** Returns `take` fake rows tagged with the priority that was queried. */
function fakeRows() {
   findMany.mockImplementation(async ({ where, take }) =>
      Array.from({ length: take }, (_, i) => ({
         id: `${where.priority}-${i}`,
      }))
   );
}

describe('priorityForOutboxType', () => {
   it('routes settlements, order fills and alerts as critical', () => {
      expect(priorityForOutboxType('settlement_completed')).toBe('critical');
      expect(priorityForOutboxType('order_filled')).toBe('critical');
      expect(priorityForOutboxType('alert_triggered')).toBe('critical');
   });

   it('routes explicit bulk and backfill work as bulk', () => {
      expect(priorityForOutboxType('bulk_reindex')).toBe('bulk');
      expect(priorityForOutboxType('backfill_trades')).toBe('bulk');
   });

   it('defaults every other type to normal', () => {
      expect(priorityForOutboxType('order_executable')).toBe('normal');
      expect(priorityForOutboxType('trade_indexed')).toBe('normal');
   });
});

describe('OutboxService.getUnpublished', () => {
   beforeEach(() => {
      findMany.mockReset();
   });

   it('excludes published and exhausted events from every query', async () => {
      fakeRows();
      await OutboxService.getUnpublished(5);

      for (const [args] of findMany.mock.calls) {
         expect(args.where).toMatchObject({
            publishedAt: null,
            attempts: { lt: OUTBOX_MAX_ATTEMPTS },
         });
      }
   });

   it('fills the batch with critical events before normal or bulk', async () => {
      fakeRows();
      const events = await OutboxService.getUnpublished(4);

      expect(events.map(e => e.id)).toEqual([
         'critical-0',
         'critical-1',
         'critical-2',
         'critical-3',
      ]);
      expect(findMany.mock.calls.map(([args]) => args.where.priority)).toEqual([
         'critical',
      ]);
   });

   it('caps bulk events per cycle so bulk work cannot fill the batch', async () => {
      findMany.mockImplementation(async ({ where, take }) =>
         where.priority === 'bulk'
            ? Array.from({ length: take }, (_, i) => ({ id: `bulk-${i}` }))
            : []
      );

      const events = await OutboxService.getUnpublished(100);

      expect(events).toHaveLength(OUTBOX_BULK_FETCH_LIMIT);
      const bulkCall = findMany.mock.calls.find(
         ([args]) => args.where.priority === 'bulk'
      );
      expect(bulkCall?.[0].take).toBe(OUTBOX_BULK_FETCH_LIMIT);
   });
});
