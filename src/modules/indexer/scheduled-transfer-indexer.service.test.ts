import { prisma } from '../../utils/prisma.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { processScheduledTransferEvent } from './scheduled-transfer-indexer.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: { $transaction: jest.fn() },
}));
jest.mock('../../utils/indexer-dlq.utils', () => ({ moveToDLQ: jest.fn() }));

const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const scheduled = {
   eventType: 'transfer_scheduled', transferId: 'transfer-1',
   txHash: 'tx-schedule', eventIndex: 0, ledger: 80,
   sender: ADDRESS, recipient: OTHER, keyId: 'key-1', amount: '10',
   releaseLedger: 100, timestamp: '2026-11-21T00:00:00Z',
};
const terminal = (eventType = 'transfer_claimed', ledger = 100) => ({
   eventType, transferId: 'transfer-1', txHash: `tx-${eventType}`,
   eventIndex: 0, ledger, timestamp: '2026-11-21T00:01:00Z',
});

describe('scheduled transfer event indexing', () => {
   let transfers: Record<string, Record<string, unknown>>;
   let journal: Array<Record<string, any>>;
   let transaction: Record<string, any>;

   beforeEach(() => {
      jest.clearAllMocks();
      transfers = {};
      journal = [];
      transaction = {
         $executeRaw: jest.fn().mockResolvedValue([]),
         scheduledTransferEvent: {
            create: jest.fn().mockImplementation(({ data }) => {
               if (journal.some(e => e.txHash === data.txHash && e.eventIndex === data.eventIndex)) {
                  throw Object.assign(new Error('Duplicate'), { code: 'P2002' });
               }
               journal = [...journal, { ...data }];
               return data;
            }),
            findFirst: jest.fn().mockImplementation(({ where }) =>
               [...journal]
                  .filter(e => e.transferId === where.transferId && e.status !== 'pending')
                  .sort((a, b) => b.ledger - a.ledger || b.eventIndex - a.eventIndex)[0] ?? null
            ),
         },
         scheduledTransfer: {
            upsert: jest.fn().mockImplementation(({ where, create }) => {
               if (!transfers[where.id]) {
                  transfers = { ...transfers, [where.id]: { ...create } };
               }
               return transfers[where.id];
            }),
            updateMany: jest.fn().mockImplementation(({ where, data }) => {
               if (!transfers[where.id]) return { count: 0 };
               transfers = { ...transfers, [where.id]: { ...transfers[where.id], ...data } };
               return { count: 1 };
            }),
         },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(fn => fn(transaction));
   });

   it('creates a pending transfer with exact integer amount', async () => {
      expect(await processScheduledTransferEvent(scheduled)).toBe(true);
      expect(transfers['transfer-1']).toMatchObject({
         id: 'transfer-1', sender: ADDRESS, recipient: OTHER,
         amount: '10', releaseLedger: 100, status: 'pending',
      });
   });

   it('canonicalizes decoded numeric identifiers without precision loss', async () => {
      await processScheduledTransferEvent({ ...scheduled, transferId: 9007199254740993n });
      expect(transfers['9007199254740993']).toMatchObject({ keyId: 'key-1' });
   });

   it.each([
      9007199254740993, -1, '18446744073709551616', 18446744073709551616n,
   ])('rejects unsafe or overflow transfer ID %s', async transferId => {
      expect(await processScheduledTransferEvent({ ...scheduled, transferId })).toBe(false);
      expect(moveToDLQ).toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
   });

   it('canonicalizes decimal IDs so aliases cannot create duplicate transfers', async () => {
      await processScheduledTransferEvent({ ...scheduled, transferId: '0001' });
      await processScheduledTransferEvent({ ...scheduled, transferId: 1n, txHash: 'second-schedule' });
      expect(Object.keys(transfers)).toEqual(['1']);
   });

   it('dedupes scheduling and terminal replays', async () => {
      await processScheduledTransferEvent(scheduled);
      expect(await processScheduledTransferEvent(scheduled)).toBe(false);
      await processScheduledTransferEvent(terminal());
      expect(await processScheduledTransferEvent(terminal())).toBe(false);
      expect(Object.keys(transfers)).toHaveLength(1);
      expect(journal).toHaveLength(2);
   });

   it.each([
      ['transfer_claimed', 'claimed'],
      ['transfer_cancelled', 'cancelled'],
   ])('records the %s terminal state', async (eventType, status) => {
      await processScheduledTransferEvent(scheduled);
      await processScheduledTransferEvent(terminal(eventType));
      expect(transfers['transfer-1'].status).toBe(status);
   });

   it('keeps a claimed transfer terminal when scheduling is redelivered', async () => {
      await processScheduledTransferEvent(scheduled);
      await processScheduledTransferEvent(terminal());
      await processScheduledTransferEvent({ ...scheduled, txHash: 'late-schedule' });
      expect(transfers['transfer-1'].status).toBe('claimed');
   });

   it('applies terminal events delivered before their schedule', async () => {
      await processScheduledTransferEvent(terminal('transfer_cancelled'));
      expect(transfers['transfer-1']).toBeUndefined();
      await processScheduledTransferEvent(scheduled);
      expect(transfers['transfer-1'].status).toBe('cancelled');
   });

   it('does not regress to an older terminal event', async () => {
      await processScheduledTransferEvent(scheduled);
      await processScheduledTransferEvent(terminal('transfer_claimed', 110));
      await processScheduledTransferEvent(terminal('transfer_cancelled', 100));
      expect(transfers['transfer-1'].status).toBe('claimed');
   });

   it.each([
      { ...scheduled, amount: '0' },
      { ...scheduled, amount: '1.5' },
      { ...scheduled, releaseLedger: 79 },
      { ...scheduled, sender: 'invalid' },
   ])('moves malformed scheduling to DLQ without state changes', async event => {
      expect(await processScheduledTransferEvent(event)).toBe(false);
      expect(moveToDLQ).toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
   });

   it('propagates database failure for batch redelivery', async () => {
      (prisma.$transaction as jest.Mock).mockRejectedValue(new Error('Database unavailable'));
      await expect(processScheduledTransferEvent(scheduled)).rejects.toThrow('Database unavailable');
   });
});
