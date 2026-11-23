// src/jobs/liquidation-keeper.job.test.ts
jest.mock('../config', () => ({
   envConfig: { VAULT_LIQUIDATION_KEEPER_ENABLED: true },
}));

jest.mock('../utils/prisma.utils', () => ({
   prisma: {
      vaultHealth: { findMany: jest.fn() },
      lendingPosition: { update: jest.fn() },
   },
}));

jest.mock('../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../modules/keys/key-twap.service', () => ({
   getTwapPrice: jest.fn(),
}));

jest.mock('../modules/vault/vault-lending.contract', () => ({
   readVaultHealthOnChain: jest.fn(),
   submitLiquidate: jest.fn(),
}));

import { prisma } from '../utils/prisma.utils';
import { runLiquidationPass } from './liquidation-keeper.job';

const mockPrisma = prisma as unknown as {
   vaultHealth: { findMany: jest.Mock };
   lendingPosition: { update: jest.Mock };
};

function row(n: number, liquidatedAt: Date | null = null) {
   return {
      positionId: `pos-${n}`,
      wallet: `GW${n}`,
      position: { id: `pos-${n}`, liquidatedAt },
   };
}

describe('liquidation-keeper', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.lendingPosition.update.mockResolvedValue({});
   });

   it('skips a position already liquidated on-chain', async () => {
      mockPrisma.vaultHealth.findMany.mockResolvedValue([row(1)]);
      const liquidate = jest.fn();

      const result = await runLiquidationPass({
         checkOnChainHealth: async () => null,
         liquidate,
      });

      expect(result.skipped).toBe(1);
      expect(liquidate).not.toHaveBeenCalled();
      expect(mockPrisma.lendingPosition.update).not.toHaveBeenCalled();
   });

   it('liquidates a position that is still unhealthy on-chain', async () => {
      mockPrisma.vaultHealth.findMany.mockResolvedValue([row(1)]);
      const liquidate = jest.fn().mockResolvedValue(undefined);

      const result = await runLiquidationPass({
         checkOnChainHealth: async () => 0.9,
         liquidate,
      });

      expect(result.liquidated).toBe(1);
      expect(liquidate).toHaveBeenCalledWith({ id: 'pos-1', wallet: 'GW1' });
      expect(mockPrisma.lendingPosition.update).toHaveBeenCalledWith({
         where: { id: 'pos-1' },
         data: { liquidatedAt: expect.any(Date) },
      });
   });

   it('ignores rows whose position is already marked liquidated', async () => {
      mockPrisma.vaultHealth.findMany.mockResolvedValue([
         row(1, new Date()),
      ]);

      const result = await runLiquidationPass({
         checkOnChainHealth: async () => 0.5,
         liquidate: jest.fn(),
      });

      expect(result.considered).toBe(0);
      expect(result.liquidated).toBe(0);
   });

   it('caps concurrent liquidations', async () => {
      mockPrisma.vaultHealth.findMany.mockResolvedValue([
         row(1),
         row(2),
         row(3),
         row(4),
      ]);

      let active = 0;
      let peak = 0;
      const liquidate = jest.fn(async () => {
         active += 1;
         peak = Math.max(peak, active);
         await new Promise(resolve => setTimeout(resolve, 5));
         active -= 1;
      });

      const result = await runLiquidationPass({
         checkOnChainHealth: async () => 0.5,
         liquidate,
         concurrency: 2,
      });

      expect(result.liquidated).toBe(4);
      expect(peak).toBeLessThanOrEqual(2);
   });
});
