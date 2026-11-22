// src/jobs/health-monitor.worker.test.ts
jest.mock('../config', () => ({
   envConfig: { VAULT_HEALTH_MONITOR_ENABLED: true },
}));

jest.mock('../utils/prisma.utils', () => ({
   prisma: {
      lendingPosition: { findMany: jest.fn() },
      vaultHealth: { upsert: jest.fn() },
   },
}));

jest.mock('../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../modules/keys/key-twap.service', () => ({
   getTwapPrice: jest.fn(),
}));

jest.mock('../modules/vault/vault-health.service', () => {
   const actual = jest.requireActual('../modules/vault/vault-health.service');
   return { ...actual, loadCollateralPriceXlm: jest.fn() };
});

import { prisma } from '../utils/prisma.utils';
import { runHealthMonitorPass } from './health-monitor.worker';

const mockPrisma = prisma as unknown as {
   lendingPosition: { findMany: jest.Mock };
   vaultHealth: { upsert: jest.Mock };
};

const openedAt = new Date('2026-01-01T00:00:00Z');
const position = {
   id: 'pos-1',
   wallet: 'GWALLET',
   collateralKeyId: 'key-1',
   collateralQuantity: '10',
   principalXlm: '50',
   interestRateBps: 0,
   openedAt,
   liquidatedAt: null,
};

describe('health-monitor worker', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.vaultHealth.upsert.mockResolvedValue({});
   });

   it('warns once per drop below the warning threshold', async () => {
      mockPrisma.lendingPosition.findMany
         .mockResolvedValueOnce([{ ...position, health: { warningAt: null } }])
         .mockResolvedValueOnce([
            { ...position, health: { warningAt: openedAt } },
         ]);

      // price 7 -> health = (7 * 10 * 0.8) / 50 = 1.12 < 1.3
      const first = await runHealthMonitorPass(openedAt, async () => 7);
      const second = await runHealthMonitorPass(openedAt, async () => 7);

      expect(first.warned).toBe(1);
      expect(second.warned).toBe(0);
      expect(mockPrisma.vaultHealth.upsert.mock.calls[0][0].create.warningAt).toEqual(
         openedAt
      );
   });

   it('clears the warning once health recovers', async () => {
      mockPrisma.lendingPosition.findMany.mockResolvedValue([
         { ...position, health: { warningAt: openedAt } },
      ]);

      // price 10 -> health = (10 * 10 * 0.8) / 50 = 1.6 > 1.3
      const result = await runHealthMonitorPass(openedAt, async () => 10);

      expect(result.warned).toBe(0);
      expect(
         mockPrisma.vaultHealth.upsert.mock.calls[0][0].update.warningAt
      ).toBeNull();
   });

   it('skips positions whose collateral price cannot be read', async () => {
      mockPrisma.lendingPosition.findMany.mockResolvedValue([position]);

      const result = await runHealthMonitorPass(openedAt, async () => null);

      expect(result.skipped).toBe(1);
      expect(mockPrisma.vaultHealth.upsert).not.toHaveBeenCalled();
   });
});
