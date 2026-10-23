import { processBadgeMintedEvents } from './badge-minted-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      walletBadge: {
         createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
   },
}));

const wallet = `G${'A'.repeat(55)}`;
const mintedAt = new Date('2026-10-20T12:00:00.000Z');
const event = {
   txHash: 'tx-badge-mint',
   eventIndex: 3,
   ledger: 800,
   timestamp: mintedAt.getTime() / 1000,
   eventType: 'BadgeMinted',
   wallet,
   badge_type: 'FIRST_BUYER',
};

beforeEach(() => {
   jest.clearAllMocks();
});

describe('processBadgeMintedEvents', () => {
   it('persists each confirmed mint with its chain timestamp and invalidates wallet caches', async () => {
      await processBadgeMintedEvents([event]);

      expect(prisma.walletBadge.createMany).toHaveBeenCalledWith({
         data: [
            {
               wallet,
               badgeType: 'FIRST_BUYER',
               mintedAt,
               txHash: 'tx-badge-mint',
               eventIndex: 3,
               ledger: 800,
            },
         ],
         skipDuplicates: true,
      });
      expect(cacheInvalidate).toHaveBeenCalledWith(
         'wallet-badges:v1:' + wallet + ':collection',
         'wallet-badges:v1:' + wallet + ':summary'
      );
   });

   it('rejects malformed mint events so the indexer cursor cannot pass them', async () => {
      await expect(
         processBadgeMintedEvents([{ ...event, badge_type: 'UNKNOWN' }])
      ).rejects.toThrow('Invalid BadgeMinted event payload');

      expect(prisma.walletBadge.createMany).not.toHaveBeenCalled();
      expect(cacheInvalidate).not.toHaveBeenCalled();
   });

   it('ignores unrelated event types', async () => {
      await processBadgeMintedEvents([{ ...event, eventType: 'KEY_BOUGHT' }]);

      expect(prisma.walletBadge.createMany).not.toHaveBeenCalled();
   });
});
