// Issue #572: structured log after each alert check run.
import { evaluatePriceAlertsForMovement } from '../alert.service';
import { prisma } from '../../../utils/prisma.utils';
import { logger } from '../../../utils/logger.utils';

jest.mock('../../../utils/prisma.utils', () => ({ prisma: { priceAlert: { findMany: jest.fn(), update: jest.fn().mockResolvedValue({}) } } }));
jest.mock('../../../utils/logger.utils', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mp = prisma as any;

describe('Issue #572: alert check structured log', () => {
   beforeEach(() => jest.clearAllMocks());

   it('debug log with all 5 fields when no alerts', async () => {
      mp.priceAlert.findMany.mockResolvedValueOnce([]);
      await evaluatePriceAlertsForMovement({ creatorId: 'c1', previousPrice: '4', currentPrice: '6', ledger_sequence: 42 });
      expect(logger.debug).toHaveBeenCalledWith(
         expect.objectContaining({ creator_id: 'c1', alerts_evaluated: 0, alerts_triggered: 0, new_price: 6, checked_at: expect.any(String) }),
         'Price alert check run'
      );
      expect(logger.info).not.toHaveBeenCalled();
   });

   it('debug log when evaluated > 0 but none triggered', async () => {
      mp.priceAlert.findMany.mockResolvedValueOnce([{ id: 'a1', creatorId: 'c1', walletAddress: 'GAAA', targetPrice: 100, direction: 'above', isActive: true, triggeredAt: null, callbackUrl: null }]);
      await evaluatePriceAlertsForMovement({ creatorId: 'c1', previousPrice: '4', currentPrice: '6' });
      expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({ creator_id: 'c1', alerts_evaluated: 1, alerts_triggered: 0 }), 'Price alert check run');
      expect(logger.info).not.toHaveBeenCalled();
   });

   it('info log when at least one alert triggers', async () => {
      mp.priceAlert.findMany.mockResolvedValueOnce([{ id: 'a1', creatorId: 'c1', walletAddress: 'GAAA', targetPrice: 5, direction: 'above', isActive: true, triggeredAt: null, callbackUrl: null }]);
      await evaluatePriceAlertsForMovement({ creatorId: 'c1', previousPrice: '4', currentPrice: '6' });
      expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ creator_id: 'c1', alerts_evaluated: 1, alerts_triggered: 1, new_price: 6, checked_at: expect.any(String) }), 'Price alert check run');
   });

   it('counts multiple triggers in one run', async () => {
      mp.priceAlert.findMany.mockResolvedValueOnce([
         { id: 'a1', creatorId: 'c1', walletAddress: 'GAAA', targetPrice: 5, direction: 'above', isActive: true, triggeredAt: null, callbackUrl: null },
         { id: 'a2', creatorId: 'c1', walletAddress: 'GBBB', targetPrice: 4.5, direction: 'above', isActive: true, triggeredAt: null, callbackUrl: null },
      ]);
      await evaluatePriceAlertsForMovement({ creatorId: 'c1', previousPrice: '4', currentPrice: '6' });
      expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ alerts_evaluated: 2, alerts_triggered: 2 }), 'Price alert check run');
   });
});