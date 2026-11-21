// Unit tests: average-cost + realised P&L persistence (#897)
// - weighted-average cost basis across buys, reset when rebuilding from zero
// - partial sells keep cost basis and persist realised delta
// - full sells reset cost basis to zero and persist realised delta

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyOwnership: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   computeCostBasisAfterSale,
   computeRealisedPnlForSale,
   recordKeyPurchase,
   recordKeySale,
} from './ownership.service';

const findUnique = prisma.keyOwnership.findUnique as jest.Mock;
const upsert = prisma.keyOwnership.upsert as jest.Mock;
const update = prisma.keyOwnership.update as jest.Mock;

describe('recordKeyPurchase average cost', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('weights the average across buys: 10@2 then 10@4 => 20@3', async () => {
      findUnique.mockResolvedValue({ balance: 10, costBasis: 2 });
      upsert.mockImplementation(async (args: any) => args);

      await recordKeyPurchase('W', 'K', 10, 4, new Date('2026-09-25T00:00:00.000Z'));

      expect(upsert).toHaveBeenCalledTimes(1);
      const call = upsert.mock.calls[0][0];
      // (2*10 + 4*10) / 20 = 3
      expect(call.update.costBasis).toBeCloseTo(3, 10);
   });

   it('resets cost basis when prior balance was zero', async () => {
      findUnique.mockResolvedValue({ balance: 0, costBasis: 100 });
      upsert.mockImplementation(async (args: any) => args);

      await recordKeyPurchase('W', 'K', 5, 10);

      const call = upsert.mock.calls[0][0];
      expect(call.update.costBasis).toBeCloseTo(10, 10);
   });

   it('resets cost basis when there was no prior position', async () => {
      findUnique.mockResolvedValue(null);
      upsert.mockImplementation(async (args: any) => args);

      await recordKeyPurchase('W', 'K', 5, 7);

      const call = upsert.mock.calls[0][0];
      expect(call.create.costBasis).toBeCloseTo(7, 10);
   });
});

describe('recordKeySale realised persistence', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('partial sell keeps cost basis and accumulates realised: 10@2 sell 4@5 => +12', async () => {
      findUnique.mockResolvedValue({ balance: 10, costBasis: 2, realisedPnl: 5 });
      update.mockImplementation(async (args: any) => args);

      await recordKeySale('W', 'K', 4, 5);

      expect(update).toHaveBeenCalledTimes(1);
      const call = update.mock.calls[0][0];
      expect(Number(call.data.balance)).toBe(6);
      // cost basis unchanged on partial sells
      expect(Number(call.data.costBasis)).toBeCloseTo(2, 10);
      // 5 + (5-2)*4 = 17
      expect(Number(call.data.realisedPnl)).toBeCloseTo(17, 10);
   });

   it('full sell resets cost basis to zero and persists realised: 10@2 sell 10@5 => +30', async () => {
      findUnique.mockResolvedValue({ balance: 10, costBasis: 2, realisedPnl: 0 });
      update.mockImplementation(async (args: any) => args);

      await recordKeySale('W', 'K', 10, 5);

      const call = update.mock.calls[0][0];
      expect(Number(call.data.balance)).toBe(0);
      expect(Number(call.data.costBasis)).toBe(0);
      expect(Number(call.data.realisedPnl)).toBeCloseTo(30, 10);
   });

   it('records a loss when selling below cost basis', async () => {
      findUnique.mockResolvedValue({ balance: 5, costBasis: 4, realisedPnl: 0 });
      update.mockImplementation(async (args: any) => args);

      await recordKeySale('W', 'K', 5, 1);

      const call = update.mock.calls[0][0];
      // (1-4)*5 = -15
      expect(Number(call.data.realisedPnl)).toBeCloseTo(-15, 10);
      expect(Number(call.data.balance)).toBe(0);
      expect(Number(call.data.costBasis)).toBe(0);
   });

   it('rejects sells exceeding the open balance', async () => {
      findUnique.mockResolvedValue({ balance: 2, costBasis: 2, realisedPnl: 0 });

      await expect(recordKeySale('W', 'K', 5, 5)).rejects.toThrow();
      expect(update).not.toHaveBeenCalled();
   });
});

describe('pure P&L helpers', () => {
   it('computeRealisedPnlForSale follows (sell - avg) * qty', () => {
      expect(computeRealisedPnlForSale(2, 5, 4)).toBeCloseTo(12, 10);
      expect(computeRealisedPnlForSale(4, 1, 5)).toBeCloseTo(-15, 10);
   });

   it('computeCostBasisAfterSale resets only when flat', () => {
      expect(computeCostBasisAfterSale(2, 10, 4)).toBe(2);
      expect(computeCostBasisAfterSale(2, 10, 10)).toBe(0);
   });
});
