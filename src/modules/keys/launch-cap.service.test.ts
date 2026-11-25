const mockFindConfig = jest.fn();
const mockFindPurchases = jest.fn();

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      launchCapConfig: {
         findUnique: (...args: any[]) => mockFindConfig(...args),
      },
      launchPurchase: {
         findMany: (...args: any[]) => mockFindPurchases(...args),
      },
   },
}));

import {
   capAt,
   getLaunchCapRamp,
   getLaunchCapStatus,
   LaunchCapSnapshot,
} from './launch-cap.service';

const baseConfig = {
   keyId: 'key-1',
   startLedger: 1000,
   endLedger: 2000,
   startCap: '100',
   endCap: '1000',
   exemptWallets: [],
   updatedAt: new Date(),
};

describe('LaunchCapService (#1349)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockFindPurchases.mockResolvedValue([]);
   });

   describe('capAt', () => {
      const snap: LaunchCapSnapshot = {
         startLedger: 1000,
         endLedger: 2000,
         startCap: 100n,
         endCap: 1000n,
      };
      it('returns startCap at (and before) window start', () => {
         expect(capAt(snap, 1000)).toBe(100n);
         expect(capAt(snap, 500)).toBe(100n);
      });
      it('returns endCap at (and after) window end', () => {
         expect(capAt(snap, 2000)).toBe(1000n);
         expect(capAt(snap, 5000)).toBe(1000n);
      });
      it('linearly interpolates between start and end', () => {
         expect(capAt(snap, 1500)).toBe(550n);
         expect(capAt(snap, 1250)).toBe(325n);
      });
      it('degenerate span (end == start) returns endCap', () => {
         expect(capAt({ ...snap, endLedger: 1000 }, 1000)).toBe(1000n);
      });
   });

   describe('getLaunchCapStatus', () => {
      it('reports no config when the key is unknown', async () => {
         mockFindConfig.mockResolvedValue(null);
         const status = await getLaunchCapStatus('missing', 'GWALLET', 1500);
         expect(status.windowActive).toBe(false);
         expect(status.cap).toBeNull();
         expect(status.remaining).toBeNull();
         expect(status.purchased).toBe('0');
      });

      it('sums cumulative purchases across many transactions in the window', async () => {
         mockFindConfig.mockResolvedValue({ ...baseConfig });
         mockFindPurchases.mockResolvedValue([
            { amount: '40', ledger: 1100 },
            { amount: '60', ledger: 1200 },
            { amount: '20', ledger: 1300 },
         ]);
         const status = await getLaunchCapStatus('key-1', 'GW', 1500);
         expect(status.purchased).toBe('120');
         expect(status.cap).toBe('550');
         expect(status.remaining).toBe('430');
         expect(status.exempt).toBe(false);
         expect(status.nextIncreaseLedger).toBe(1501);
      });

      it('clamps remaining at zero when purchased exceeds current cap', async () => {
         mockFindConfig.mockResolvedValue({ ...baseConfig });
         mockFindPurchases.mockResolvedValue([{ amount: '2000', ledger: 1100 }]);
         const status = await getLaunchCapStatus('key-1', 'GW', 1200);
         expect(status.remaining).toBe('0');
         expect(BigInt(status.purchased)).toBeGreaterThan(BigInt(status.cap!));
      });

      it('exempt wallets have no cap and no remaining', async () => {
         mockFindConfig.mockResolvedValue({ ...baseConfig, exemptWallets: ['GW'] });
         mockFindPurchases.mockResolvedValue([{ amount: '5000', ledger: 1100 }]);
         const status = await getLaunchCapStatus('key-1', 'GW', 1500);
         expect(status.exempt).toBe(true);
         expect(status.cap).toBeNull();
         expect(status.remaining).toBeNull();
         expect(status.purchased).toBe('5000');
      });

      it('returns no cap data once the window has ended', async () => {
         mockFindConfig.mockResolvedValue({ ...baseConfig });
         mockFindPurchases.mockResolvedValue([{ amount: '50', ledger: 1500 }]);
         const status = await getLaunchCapStatus('key-1', 'GW', 5000);
         expect(status.windowActive).toBe(false);
         expect(status.cap).toBeNull();
         expect(status.remaining).toBeNull();
         expect(status.nextIncreaseLedger).toBeNull();
      });
   });

   describe('getLaunchCapRamp', () => {
      it('samples the ramp inclusively at start and end', async () => {
         mockFindConfig.mockResolvedValue({ ...baseConfig });
         const ramp = await getLaunchCapRamp('key-1', 3);
         expect(ramp).toHaveLength(3);
         expect(ramp[0]).toEqual({ ledger: 1000, cap: '100' });
         expect(ramp[2]).toEqual({ ledger: 2000, cap: '1000' });
         expect(ramp[1].cap).toBe('550');
      });

      it('is empty when no config exists', async () => {
         mockFindConfig.mockResolvedValue(null);
         expect(await getLaunchCapRamp('missing', 5)).toEqual([]);
      });
   });
});
