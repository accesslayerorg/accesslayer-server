import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { score } from './reputation.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      stellarWallet: { findUnique: jest.fn() },
      trade: { count: jest.fn() },
      fraudReport: { count: jest.fn() },
      sellBlock: { count: jest.fn() },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheInvalidate: jest.fn(),
   cacheSetJson: jest.fn(),
}));

describe('wallet reputation sell-block factor', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (cacheGetJson as jest.Mock).mockResolvedValue(null);
      (prisma.stellarWallet.findUnique as jest.Mock).mockResolvedValue({
         createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      });
      (prisma.trade.count as jest.Mock).mockResolvedValue(100);
      (prisma.fraudReport.count as jest.Mock).mockResolvedValue(0);
      (prisma.sellBlock.count as jest.Mock).mockResolvedValue(3);
   });

   it('includes sell-block frequency as a score input and lowers reputation', async () => {
      const result = await score('GSELLER');

      expect(prisma.sellBlock.count).toHaveBeenCalledWith({
         where: { wallet: 'GSELLER' },
      });
      expect(result.factors).toMatchObject({
         tradeCount: 100,
         rejectedReports: 0,
         sellBlockCount: 3,
      });
      expect(result.score).toBe(55);
      expect(cacheSetJson).toHaveBeenCalledWith(
         'reputation:v2:GSELLER',
         expect.objectContaining({
            factors: expect.objectContaining({ sellBlockCount: 3 }),
         }),
         300
      );
   });
});
