import { parsePolEvent, processPolEvents } from './pol-indexer.service';
jest.mock('../../utils/prisma.utils', () => ({ prisma: { $transaction: jest.fn() } }));
jest.mock('../../utils/redis.utils', () => ({ cacheInvalidate: jest.fn() }));
jest.mock('../../utils/indexer-dlq.utils', () => ({ moveToDLQ: jest.fn() }));
jest.mock('../whitelist/whitelist.service', () => ({ resolveCreatorId: jest.fn().mockResolvedValue(null) }));
import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';

const event = (eventType = 'pol_funded', extra = {}) => ({
   eventType, txHash: 'pol-test-tx', eventIndex: 0, ledger: 100,
   amount: '10000000', keyId: 'key-a', ...extra,
});
describe('POL event projection', () => {
   beforeEach(() => jest.clearAllMocks());
   it('preserves exact stroops and supports event aliases', () => {
      expect(parsePolEvent(event())).toMatchObject({ amount: '10000000', type: 'funded' });
      expect(parsePolEvent(event('BackstopApplied'))).toMatchObject({ type: 'applied', keyId: 'key-a' });
      expect(parsePolEvent(event('BACKSTOP_REPAID'))).toMatchObject({ type: 'repaid' });
   });
   it.each(['0', '-1', '1.2', '', '170141183460469231731687303715884105728'])('rejects invalid amount %s', amount => {
      expect(() => parsePolEvent(event('pol_funded', { amount }))).toThrow();
   });
   it('rejects absent key and unsafe numeric amounts', () => {
      expect(() => parsePolEvent(event('backstop_applied', { keyId: undefined }))).toThrow();
      expect(() => parsePolEvent(event('pol_funded', { amount: Number.MAX_SAFE_INTEGER + 1 }))).toThrow();
   });
   it('dedupes receipts and changes balances in the same transaction', async () => {
      const tx = { backstop: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
         polReserve: { upsert: jest.fn() } };
      (prisma.$transaction as jest.Mock).mockImplementation(async fn => fn(tx));
      await processPolEvents([event(), event('backstop_applied', { eventIndex: 1, amount: '2000000' }),
         event('backstop_repaid', { eventIndex: 2, amount: '1000000' })]);
      expect(tx.polReserve.upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
         update: { balance: { increment: '10000000' } },
      }));
      expect(tx.polReserve.upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
         update: { balance: { decrement: '2000000' }, deployedAmount: { increment: '2000000' } },
      }));
      expect(tx.polReserve.upsert).toHaveBeenNthCalledWith(3, expect.objectContaining({
         update: { balance: { increment: '1000000' }, repaidAmount: { increment: '1000000' } },
      }));
      expect(cacheInvalidate).toHaveBeenCalledTimes(3);
   });
   it('replayed receipts skip balance changes and still invalidate cache', async () => {
      const tx = { backstop: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
         polReserve: { upsert: jest.fn() } };
      (prisma.$transaction as jest.Mock).mockImplementation(async fn => fn(tx));
      await processPolEvents([event()]);
      expect(tx.polReserve.upsert).not.toHaveBeenCalled();
      expect(cacheInvalidate).toHaveBeenCalled();
   });
   it('moves malformed events to DLQ and propagates database failures', async () => {
      await processPolEvents([event('backstop_applied', { amount: '-1' })]);
      expect(moveToDLQ).toHaveBeenCalled();
      (prisma.$transaction as jest.Mock).mockRejectedValue(new Error('database unavailable'));
      await expect(processPolEvents([event()])).rejects.toThrow('database unavailable');
   });
});
