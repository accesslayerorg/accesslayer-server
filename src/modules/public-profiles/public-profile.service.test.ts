// src/modules/public-profiles/public-profile.service.test.ts

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      publicProfile: {
         findUnique: jest.fn(),
         upsert: jest.fn(),
      },
      stellarWallet: { findUnique: jest.fn() },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
   cacheInvalidate: jest.fn(),
}));

jest.mock('../portfolio/portfolio-pnl.service', () => ({
   getPortfolioPnl: jest.fn(),
}));

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheInvalidate, cacheSetJson } from '../../utils/redis.utils';
import { getPortfolioPnl } from '../portfolio/portfolio-pnl.service';
import {
   getPublicProfileView,
   upsertPublicProfile,
   toRange,
   XLM_RANGE_BOUNDARIES,
   KEY_COUNT_RANGE_BOUNDARIES,
   PUBLIC_PROFILE_CACHE_TTL_SECONDS,
   PublicProfileError,
} from './public-profile.service';

const mockPrisma = prisma as any;
const WALLET = 'GOWNERWALLETADDRESS';

const PNL = {
   positions: [
      { keyId: 'key-a', quantity: 3, currentValue: 420.5 },
      { keyId: 'key-b', quantity: 1, currentValue: 80 },
   ],
   summary: {
      positionCount: 2,
      totalCurrentValue: 500.5,
      totalRealisedPnl: -40,
      totalUnrealisedPnl: 15.25,
      totalLiquidationValue: 480,
      markToMarketVsLiquidationDelta: 20.5,
   },
};

function profileRow(overrides: Record<string, unknown> = {}) {
   return {
      id: 'pp-1',
      wallet: WALLET,
      handle: 'alice',
      enabled: true,
      showHoldings: false,
      showPnl: false,
      showKeyCount: false,
      showJoined: false,
      showWallet: false,
      showExactAmounts: false,
      createdAt: new Date('2026-03-04T05:06:07Z'),
      updatedAt: new Date('2026-03-04T05:06:07Z'),
      ...overrides,
   };
}

/** Every key path in a JSON value, so "never appears in any form" can be asserted. */
function allKeys(value: unknown, out: string[] = []): string[] {
   if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
         out.push(key);
         allKeys(child, out);
      }
   }
   return out;
}

describe('public-profile.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (cacheGetJson as jest.Mock).mockResolvedValue(null);
      (getPortfolioPnl as jest.Mock).mockResolvedValue(PNL);
      mockPrisma.stellarWallet.findUnique.mockResolvedValue({
         createdAt: new Date('2026-01-15T12:00:00Z'),
      });
   });

   describe('toRange', () => {
      it('buckets positive values with an exclusive upper edge', () => {
         expect(toRange(0, XLM_RANGE_BOUNDARIES)).toEqual({ min: 0, max: 10 });
         expect(toRange(9.99, XLM_RANGE_BOUNDARIES)).toEqual({ min: 0, max: 10 });
         expect(toRange(10, XLM_RANGE_BOUNDARIES)).toEqual({ min: 10, max: 100 });
         expect(toRange(500.5, XLM_RANGE_BOUNDARIES)).toEqual({ min: 100, max: 1000 });
         expect(toRange(5_000_000, XLM_RANGE_BOUNDARIES)).toEqual({ min: 1_000_000, max: null });
      });

      it('mirrors negative values onto the matching negative bucket', () => {
         expect(toRange(-150, XLM_RANGE_BOUNDARIES)).toEqual({ min: -1000, max: -100 });
         expect(toRange(-2_000_000, XLM_RANGE_BOUNDARIES)).toEqual({
            min: Number.NEGATIVE_INFINITY,
            max: -1_000_000,
         });
      });

      it('buckets key counts', () => {
         expect(toRange(0, KEY_COUNT_RANGE_BOUNDARIES)).toEqual({ min: 0, max: 1 });
         expect(toRange(2, KEY_COUNT_RANGE_BOUNDARIES)).toEqual({ min: 1, max: 5 });
         expect(toRange(250, KEY_COUNT_RANGE_BOUNDARIES)).toEqual({ min: 100, max: null });
      });
   });

   describe('getPublicProfileView privacy filtering', () => {
      it('exposes only the handle when every flag is off, and never the wallet', async () => {
         mockPrisma.publicProfile.findUnique.mockResolvedValue(profileRow());

         const view = await getPublicProfileView('alice');

         expect(view).toEqual({ handle: 'alice' });
         expect(JSON.stringify(view)).not.toContain(WALLET);
         // No portfolio data is even computed when nothing needs it.
         expect(getPortfolioPnl).not.toHaveBeenCalled();
      });

      it('replaces exact amounts with ranges when exact amounts are hidden', async () => {
         mockPrisma.publicProfile.findUnique.mockResolvedValue(
            profileRow({ showHoldings: true, showPnl: true, showKeyCount: true })
         );

         const view = await getPublicProfileView('alice');

         expect(view).toEqual({
            handle: 'alice',
            keyCount: { min: 1, max: 5 },
            holdings: { totalValueRangeXlm: { min: 100, max: 1000 } },
            pnl: { totalPnlRangeXlm: { min: -100, max: -10 } },
         });
         const serialized = JSON.stringify(view);
         for (const exact of ['500.5', '420.5', '15.25', 'key-a', 'positions', 'quantity']) {
            expect(serialized).not.toContain(exact);
         }
      });

      it('publishes exact amounts and positions only when opted in', async () => {
         mockPrisma.publicProfile.findUnique.mockResolvedValue(
            profileRow({ showHoldings: true, showPnl: true, showKeyCount: true, showExactAmounts: true })
         );

         const view = await getPublicProfileView('alice');

         expect(view).toEqual({
            handle: 'alice',
            keyCount: 2,
            holdings: {
               totalValueXlm: 500.5,
               positions: [
                  { keyId: 'key-a', quantity: 3, valueXlm: 420.5 },
                  { keyId: 'key-b', quantity: 1, valueXlm: 80 },
               ],
            },
            pnl: { totalPnlXlm: -24.75, realisedPnlXlm: -40, unrealisedPnlXlm: 15.25 },
         });
      });

      it('withholds per-key positions when the key count is hidden, since their length reveals it', async () => {
         mockPrisma.publicProfile.findUnique.mockResolvedValue(
            profileRow({ showHoldings: true, showKeyCount: false, showExactAmounts: true })
         );

         const view = await getPublicProfileView('alice');

         expect(view).toEqual({ handle: 'alice', holdings: { totalValueXlm: 500.5 } });
         expect(JSON.stringify(view)).not.toContain('key-a');
      });

      it.each([
         ['showHoldings', 'holdings'],
         ['showPnl', 'pnl'],
         ['showKeyCount', 'keyCount'],
         ['showJoined', 'joinedAt'],
         ['showWallet', 'wallet'],
      ])('omits %s-controlled field entirely when only the other fields are on', async (flag, field) => {
         const everythingOn = {
            showHoldings: true,
            showPnl: true,
            showKeyCount: true,
            showJoined: true,
            showWallet: true,
            showExactAmounts: true,
         };
         mockPrisma.publicProfile.findUnique.mockResolvedValue(
            profileRow({ ...everythingOn, [flag]: false })
         );

         const view = await getPublicProfileView('alice');

         expect(view).not.toHaveProperty(field);
         const keys = allKeys(view);
         const hiddenKeys: Record<string, string[]> = {
            holdings: ['holdings', 'totalValueXlm', 'totalValueRangeXlm', 'positions'],
            pnl: ['pnl', 'totalPnlXlm', 'totalPnlRangeXlm', 'realisedPnlXlm', 'unrealisedPnlXlm'],
            keyCount: ['keyCount'],
            joinedAt: ['joinedAt'],
            wallet: ['wallet'],
         };
         for (const key of hiddenKeys[field]) expect(keys).not.toContain(key);
         if (field === 'wallet') expect(JSON.stringify(view)).not.toContain(WALLET);
      });

      it('shows the wallet and a day-precision joined date when opted in', async () => {
         mockPrisma.publicProfile.findUnique.mockResolvedValue(
            profileRow({ showWallet: true, showJoined: true })
         );

         const view = await getPublicProfileView('alice');

         expect(view).toEqual({ handle: 'alice', wallet: WALLET, joinedAt: '2026-01-15' });
      });

      it('falls back to the profile creation date when the wallet has no account row', async () => {
         mockPrisma.stellarWallet.findUnique.mockResolvedValue(null);
         mockPrisma.publicProfile.findUnique.mockResolvedValue(profileRow({ showJoined: true }));

         const view = await getPublicProfileView('alice');

         expect(view?.joinedAt).toBe('2026-03-04');
      });

      it('returns null for disabled and unknown handles alike', async () => {
         mockPrisma.publicProfile.findUnique.mockResolvedValueOnce(
            profileRow({ enabled: false, showWallet: true })
         );
         expect(await getPublicProfileView('alice')).toBeNull();

         mockPrisma.publicProfile.findUnique.mockResolvedValueOnce(null);
         expect(await getPublicProfileView('nobody')).toBeNull();

         expect(cacheSetJson).not.toHaveBeenCalled();
      });

      it('looks handles up case-insensitively and rejects malformed ones without a query', async () => {
         mockPrisma.publicProfile.findUnique.mockResolvedValue(profileRow());

         await getPublicProfileView('ALICE');
         expect(mockPrisma.publicProfile.findUnique).toHaveBeenCalledWith({ where: { handle: 'alice' } });

         mockPrisma.publicProfile.findUnique.mockClear();
         expect(await getPublicProfileView('no spaces!')).toBeNull();
         expect(mockPrisma.publicProfile.findUnique).not.toHaveBeenCalled();
      });
   });

   describe('caching', () => {
      it('caches a built view for 60 seconds', async () => {
         mockPrisma.publicProfile.findUnique.mockResolvedValue(profileRow({ showKeyCount: true }));

         const view = await getPublicProfileView('alice');

         expect(cacheSetJson).toHaveBeenCalledWith('public-profile:v1:alice', view, 60);
         expect(PUBLIC_PROFILE_CACHE_TTL_SECONDS).toBe(60);
      });

      it('serves a cache hit without touching the database', async () => {
         (cacheGetJson as jest.Mock).mockResolvedValue({ handle: 'alice', keyCount: 2 });

         const view = await getPublicProfileView('alice');

         expect(view).toEqual({ handle: 'alice', keyCount: 2 });
         expect(mockPrisma.publicProfile.findUnique).not.toHaveBeenCalled();
         expect(getPortfolioPnl).not.toHaveBeenCalled();
      });
   });

   describe('upsertPublicProfile', () => {
      beforeEach(() => {
         mockPrisma.publicProfile.upsert.mockImplementation(async (args: any) => ({
            handle: args.create.handle,
            ...args.update,
         }));
      });

      it('stores the handle lowercased and invalidates its cache key', async () => {
         mockPrisma.publicProfile.findUnique.mockResolvedValue(null);

         await upsertPublicProfile(WALLET, { handle: '  Alice_99 ', enabled: true });

         expect(mockPrisma.publicProfile.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
               where: { wallet: WALLET },
               create: { wallet: WALLET, handle: 'alice_99', enabled: true },
               update: { handle: 'alice_99', enabled: true },
            })
         );
         expect(cacheInvalidate).toHaveBeenCalledWith('public-profile:v1:alice_99');
      });

      it('leaves omitted flags untouched on update', async () => {
         mockPrisma.publicProfile.findUnique
            .mockResolvedValueOnce({ wallet: WALLET })
            .mockResolvedValueOnce({ handle: 'alice' });

         await upsertPublicProfile(WALLET, { handle: 'alice', showPnl: true });

         const { update } = mockPrisma.publicProfile.upsert.mock.calls[0][0];
         expect(update).toEqual({ handle: 'alice', showPnl: true });
      });

      it('invalidates both the old and the new handle on rename', async () => {
         mockPrisma.publicProfile.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ handle: 'old_name' });

         await upsertPublicProfile(WALLET, { handle: 'new_name' });

         expect(cacheInvalidate).toHaveBeenCalledWith(
            'public-profile:v1:new_name',
            'public-profile:v1:old_name'
         );
      });

      it.each(['admin', 'API', 'Me', 'public', 'settings', 'support'])(
         'rejects the reserved handle %s',
         async handle => {
            await expect(upsertPublicProfile(WALLET, { handle })).rejects.toMatchObject({
               statusCode: 400,
               message: 'This handle is reserved',
            });
            expect(mockPrisma.publicProfile.upsert).not.toHaveBeenCalled();
         }
      );

      it.each(['ab', 'a'.repeat(31), 'has space', 'dash-ed', 'émile'])(
         'rejects the malformed handle %p',
         async handle => {
            await expect(upsertPublicProfile(WALLET, { handle })).rejects.toMatchObject({
               statusCode: 400,
            });
         }
      );

      it('rejects a handle owned by another wallet, whatever its casing', async () => {
         mockPrisma.publicProfile.findUnique.mockResolvedValueOnce({ wallet: 'GSOMEONEELSE' });

         await expect(upsertPublicProfile(WALLET, { handle: 'ALICE' })).rejects.toMatchObject({
            statusCode: 409,
            code: 'CONFLICT',
         });
         expect(mockPrisma.publicProfile.findUnique).toHaveBeenCalledWith({
            where: { handle: 'alice' },
            select: { wallet: true },
         });
         expect(mockPrisma.publicProfile.upsert).not.toHaveBeenCalled();
      });

      it('maps a unique-constraint race to 409', async () => {
         mockPrisma.publicProfile.findUnique.mockResolvedValue(null);
         mockPrisma.publicProfile.upsert.mockRejectedValue(
            Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
         );

         const attempt = upsertPublicProfile(WALLET, { handle: 'alice' });
         await expect(attempt).rejects.toBeInstanceOf(PublicProfileError);
         await expect(attempt).rejects.toMatchObject({ statusCode: 409 });
         expect(cacheInvalidate).not.toHaveBeenCalled();
      });
   });
});
