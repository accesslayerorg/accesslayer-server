
// Issue #1012: alert triggers, is disabled, and shows in the in-app feed.
// Unit test — mocks prisma and logger, no DB required.
import { evaluatePriceAlertsForMovement } from '../alert.service';
import { listNotifications } from '../../notifications/notification.service';
import { prisma } from '../../../utils/prisma.utils';
import { logger } from '../../../utils/logger.utils';
import { NOTIFICATION_TYPES } from '../../../constants/notifications.constants';

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: {
      priceAlert: { findMany: jest.fn(), update: jest.fn() },
      creatorPriceSnapshot: { findMany: jest.fn() },
      trade: { findMany: jest.fn().mockResolvedValue([]) },
      keyOwnership: { findMany: jest.fn().mockResolvedValue([]) },
      creatorProfile: { findMany: jest.fn().mockResolvedValue([]) },
   },
}));
jest.mock('../../../utils/logger.utils', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../utils/redis.utils', () => ({ getRedis: () => null }));
jest.mock('../../keys/price-moved.redis', () => ({ getPriceMovedKeyIds: jest.fn().mockResolvedValue([]), markPriceMovedDelivered: jest.fn() }));

const mp = prisma as any;

describe('Issue #1012: alert fires, disables, and appears in the notification feed', () => {
   afterEach(() => jest.clearAllMocks());
   it('disables alert and surfaces it via listNotifications', async () => {
      const wallet = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const triggeredAt = new Date('2026-10-17T00:00:00Z');
      const activeAlert = { id: 'a1', creatorId: 'c1', walletAddress: wallet, targetPrice: 5, direction: 'above', isActive: true, triggeredAt: null, callbackUrl: null };
      const triggeredAlert = { ...activeAlert, isActive: false, triggeredAt };
      mp.priceAlert.findMany.mockResolvedValueOnce([activeAlert]);
      mp.priceAlert.update.mockResolvedValueOnce(triggeredAlert);
      mp.creatorPriceSnapshot.findMany.mockResolvedValue([{ creatorId: 'c1', currentPrice: '6', price24hAgo: '4', updatedAt: triggeredAt }]);
      await evaluatePriceAlertsForMovement({ creatorId: 'c1', previousPrice: '4', currentPrice: '6' });
      expect(mp.priceAlert.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { isActive: false, triggeredAt: expect.any(Date) } });
      mp.priceAlert.findMany.mockResolvedValueOnce([triggeredAlert]);
      const items = await listNotifications(wallet);
      const hit = items.find((i) => i.type === NOTIFICATION_TYPES.PRICE_ALERT_TRIGGERED);
      expect(hit).toBeDefined();
      expect(hit!.payload).toEqual({ alertId: 'a1', keyId: 'c1', targetPrice: '5', triggeredPrice: '6', direction: 'above' });
   });
   it('does not trigger when threshold is not crossed', async () => {
      mp.priceAlert.findMany.mockResolvedValueOnce([{ id: 'a1', creatorId: 'c1', walletAddress: 'GAAA', targetPrice: 10, direction: 'above', isActive: true, triggeredAt: null, callbackUrl: null }]);
      await evaluatePriceAlertsForMovement({ creatorId: 'c1', previousPrice: '4', currentPrice: '6' });
      expect(mp.priceAlert.update).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
   });
   it('webhook failure does not prevent alert disable', async () => {
      const wallet = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      mp.priceAlert.findMany.mockResolvedValueOnce([{ id: 'a1', creatorId: 'c1', walletAddress: wallet, targetPrice: 5, direction: 'above', isActive: true, triggeredAt: null, callbackUrl: 'https://example.com/cb' }]);
      const fetchSpy = jest.spyOn(global, 'fetch' as any).mockRejectedValue(new Error('network down'));
      await evaluatePriceAlertsForMovement({ creatorId: 'c1', previousPrice: '4', currentPrice: '6' });
      expect(mp.priceAlert.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { isActive: false, triggeredAt: expect.any(Date) } });
      expect(logger.error).toHaveBeenCalled();
      fetchSpy.mockRestore();
   });
});
