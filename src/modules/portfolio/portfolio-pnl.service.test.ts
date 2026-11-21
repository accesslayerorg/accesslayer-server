// Unit tests: GET /portfolio/pnl (#897)
// - per-position unrealised = (live sell price - avg buy price) * qty
// - totals aggregate across positions; liquidation via computeSellPayout
// - realised includes closed (zero-balance) positions
// - live supply is re-read on every call (no stale cache)

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyOwnership: { findMany: jest.fn() },
      creatorProfile: { findMany: jest.fn() },
      protocolConfig: { findUnique: jest.fn() },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { getPortfolioPnl } from './portfolio-pnl.service';

const ownershipFindMany = prisma.keyOwnership.findMany as jest.Mock;
const creatorFindMany = prisma.creatorProfile.findMany as jest.Mock;
const protocolFindUnique = prisma.protocolConfig.findUnique as jest.Mock;

const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function setupMocks(options: {
   ownerships: Array<{ creatorId: string; balance: number; costBasis: number; realisedPnl?: number }>;
   supplies: Record<string, number>;
   feeBps?: number;
}) {
   ownershipFindMany.mockResolvedValue(
      options.ownerships.map(o => ({
         creatorId: o.creatorId,
         balance: o.balance,
         costBasis: o.costBasis,
         realisedPnl: o.realisedPnl ?? 0,
      }))
   );
   creatorFindMany.mockResolvedValue(
      Object.entries(options.supplies).map(([id, circulatingSupply]) => ({
         id,
         circulatingSupply,
      }))
   );
   protocolFindUnique.mockResolvedValue({ protocolFeeBps: options.feeBps ?? 0 });
}

describe('getPortfolioPnl', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('returns empty positions and zero totals when the wallet holds nothing', async () => {
      setupMocks({ ownerships: [], supplies: {} });

      const result = await getPortfolioPnl(WALLET);

      expect(result.positions).toEqual([]);
      expect(result.summary).toMatchObject({
         positionCount: 0,
         totalUnrealisedPnl: 0,
         totalRealisedPnl: 0,
         totalCurrentValue: 0,
         totalLiquidationValue: 0,
      });
   });

   it('computes unrealised P&L from the live bonding-curve sell price', async () => {
      // fee 0, supply 10: unit sell = 10_000_000 + 9*1_000_000 = 19_000_000 stroops = 1.9 XLM
      setupMocks({
         ownerships: [{ creatorId: 'key-1', balance: 10, costBasis: 1 }],
         supplies: { 'key-1': 10 },
         feeBps: 0,
      });

      const result = await getPortfolioPnl(WALLET);

      expect(result.positions).toHaveLength(1);
      const [pos] = result.positions;
      expect(pos.currentSellPrice).toBeCloseTo(1.9, 7);
      // (1.9 - 1) * 10 = 9
      expect(pos.unrealisedPnl).toBeCloseTo(9, 7);
      expect(pos.currentValue).toBeCloseTo(19, 7);
      expect(result.summary.totalUnrealisedPnl).toBeCloseTo(9, 7);
      expect(result.summary.positionCount).toBe(1);
   });

   it('uses computeSellPayout liquidation (<= mark-to-market) for multi-key positions', async () => {
      // supply 10, qty 5, fee 0:
      // mark-to-market = 5 * 1.9 = 9.5
      // liquidation walks 9,8,7,6,5 => (19+18+17+16+15)M = 85M = 8.5 XLM
      setupMocks({
         ownerships: [{ creatorId: 'key-1', balance: 5, costBasis: 1 }],
         supplies: { 'key-1': 10 },
         feeBps: 0,
      });

      const result = await getPortfolioPnl(WALLET);
      const [pos] = result.positions;

      expect(pos.currentValue).toBeCloseTo(9.5, 7);
      expect(pos.liquidationValue).toBeCloseTo(8.5, 7);
      expect(pos.liquidationValue).toBeLessThanOrEqual(pos.currentValue);
      expect(result.summary.totalLiquidationValue).toBeCloseTo(8.5, 7);
      expect(result.summary.markToMarketVsLiquidationDelta).toBeCloseTo(1.0, 7);
   });

   it('aggregates totals across multiple positions sorted by current value', async () => {
      setupMocks({
         ownerships: [
            { creatorId: 'key-small', balance: 1, costBasis: 1, realisedPnl: 2 },
            { creatorId: 'key-big', balance: 10, costBasis: 1, realisedPnl: 3 },
         ],
         supplies: { 'key-small': 10, 'key-big': 10 },
         feeBps: 0,
      });

      const result = await getPortfolioPnl(WALLET);

      expect(result.positions.map(p => p.keyId)).toEqual(['key-big', 'key-small']);
      const big = result.positions[0];
      const small = result.positions[1];
      expect(result.summary.totalUnrealisedPnl).toBeCloseTo(
         big.unrealisedPnl + small.unrealisedPnl,
         7
      );
      expect(result.summary.totalCurrentValue).toBeCloseTo(
         big.currentValue + small.currentValue,
         7
      );
      expect(result.summary.totalLiquidationValue).toBeCloseTo(
         big.liquidationValue + small.liquidationValue,
         7
      );
      // realised sums across open positions
      expect(result.summary.totalRealisedPnl).toBeCloseTo(5, 7);
      expect(result.summary.positionCount).toBe(2);
   });

   it('includes realised P&L from closed (zero-balance) positions in the total', async () => {
      setupMocks({
         ownerships: [
            { creatorId: 'key-open', balance: 2, costBasis: 1, realisedPnl: 1 },
            { creatorId: 'key-closed', balance: 0, costBasis: 0, realisedPnl: 7.5 },
         ],
         supplies: { 'key-open': 10 },
         feeBps: 0,
      });

      const result = await getPortfolioPnl(WALLET);

      // Only the open position is listed...
      expect(result.positions.map(p => p.keyId)).toEqual(['key-open']);
      // ...but realised aggregates both.
      expect(result.summary.totalRealisedPnl).toBeCloseTo(8.5, 7);
   });

   it('reflects the latest supply on every call without a stale cache', async () => {
      setupMocks({
         ownerships: [{ creatorId: 'key-1', balance: 1, costBasis: 1 }],
         supplies: { 'key-1': 10 },
         feeBps: 0,
      });
      const first = await getPortfolioPnl(WALLET);

      setupMocks({
         ownerships: [{ creatorId: 'key-1', balance: 1, costBasis: 1 }],
         supplies: { 'key-1': 20 },
         feeBps: 0,
      });
      const second = await getPortfolioPnl(WALLET);

      // supply 20 unit = 10 + 19 = 29M = 2.9 XLM vs 1.9 XLM before
      expect(second.positions[0].currentSellPrice).toBeCloseTo(2.9, 7);
      expect(second.positions[0].currentSellPrice).not.toBeCloseTo(
         first.positions[0].currentSellPrice,
         7
      );
      // No snapshot/redis read models are consulted.
      expect((prisma as any).creatorPriceSnapshot).toBeUndefined();
   });
});
