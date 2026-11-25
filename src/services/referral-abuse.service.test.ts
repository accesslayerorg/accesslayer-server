// Unit tests for referral abuse detection (#1241): one group per rule.

jest.mock('../utils/prisma.utils', () => ({
   prisma: {
      walletFundingSource: { findMany: jest.fn() },
      referral: { findMany: jest.fn() },
   },
}));
jest.mock('./wallet-funding.service', () => ({
   getFundingSource: jest.fn(),
}));
jest.mock('../config', () => ({
   envConfig: { REFERRAL_ABUSE_FUNDER_ALLOWLIST: undefined },
}));

import { envConfig } from '../config';
import { prisma } from '../utils/prisma.utils';
import { getFundingSource } from './wallet-funding.service';
import {
   CLUSTER_THRESHOLD,
   ReferralAbuseService,
   densestWindowCount,
   hasDenseWindow,
} from './referral-abuse.service';

const getFunding = getFundingSource as jest.Mock;
const sourcesFindMany = prisma.walletFundingSource.findMany as jest.Mock;
const referralFindMany = prisma.referral.findMany as jest.Mock;
const config = envConfig as { REFERRAL_ABUSE_FUNDER_ALLOWLIST?: string };

const REFERRER = 'GREFERRER';
const REFEREE = 'GREFEREE';
const FUNDER = 'GFUNDER';
const T0 = new Date('2026-11-01T00:00:00.000Z');
const HOUR = 3_600_000;
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

/** Funding lookups keyed by address; unknown addresses resolve to null. */
function fundings(map: Record<string, { funder: string; fundedAt: Date }>) {
   getFunding.mockImplementation(
      async (address: string) => map[address] ?? null
   );
}

/** Funding rows for `n` cluster members funded `spacingHours` apart. */
function clusterRows(n: number, spacingHours: number, startHours = 0) {
   return Array.from({ length: n }, (_, i) => ({
      address: i === 0 ? REFEREE : `GMEMBER${i}`,
      fundedAt: at(startHours + i * spacingHours),
   }));
}

function seedCluster(rows: Array<{ address: string; fundedAt: Date }>) {
   sourcesFindMany.mockResolvedValue(rows);
   referralFindMany.mockResolvedValue(
      rows.map(r => ({ refereeAddress: r.address }))
   );
}

beforeEach(() => {
   jest.clearAllMocks();
   config.REFERRAL_ABUSE_FUNDER_ALLOWLIST = undefined;
   sourcesFindMany.mockResolvedValue([]);
   referralFindMany.mockResolvedValue([]);
});

describe('self-referral', () => {
   it('rejects and records the reason, without any funding lookup', async () => {
      const decision = await ReferralAbuseService.evaluate({
         referrerAddress: REFEREE,
         refereeAddress: REFEREE,
      });

      expect(decision).toEqual({
         action: 'reject',
         reason: 'SELF_REFERRAL',
         details: { wallet: REFEREE },
      });
      expect(getFunding).not.toHaveBeenCalled();
   });
});

describe('linked wallets', () => {
   it('rejects when the referrer funded the referee', async () => {
      fundings({ [REFEREE]: { funder: REFERRER, fundedAt: T0 } });
      const decision = await ReferralAbuseService.evaluate({
         referrerAddress: REFERRER,
         refereeAddress: REFEREE,
      });
      expect(decision).toMatchObject({
         action: 'reject',
         reason: 'LINKED_WALLETS',
         details: { fundedBy: 'referrer', funder: REFERRER },
      });
   });

   it('rejects when the referee funded the referrer', async () => {
      fundings({ [REFERRER]: { funder: REFEREE, fundedAt: T0 } });
      const decision = await ReferralAbuseService.evaluate({
         referrerAddress: REFERRER,
         refereeAddress: REFEREE,
      });
      expect(decision).toMatchObject({
         action: 'reject',
         reason: 'LINKED_WALLETS',
         details: { fundedBy: 'referee' },
      });
   });
});

describe('shared funding source', () => {
   it('rejects when referrer and referee were first funded by the same account', async () => {
      fundings({
         [REFERRER]: { funder: FUNDER, fundedAt: at(-500) },
         [REFEREE]: { funder: FUNDER, fundedAt: T0 },
      });
      const decision = await ReferralAbuseService.evaluate({
         referrerAddress: REFERRER,
         refereeAddress: REFEREE,
      });
      expect(decision).toEqual({
         action: 'reject',
         reason: 'SHARED_FUNDING_SOURCE',
         details: { funder: FUNDER },
      });
   });

   it('does not reject when the shared funder is allowlisted (e.g. an exchange)', async () => {
      config.REFERRAL_ABUSE_FUNDER_ALLOWLIST = ` GOTHER , ${FUNDER} `;
      fundings({
         [REFERRER]: { funder: FUNDER, fundedAt: at(-500) },
         [REFEREE]: { funder: FUNDER, fundedAt: T0 },
      });
      await expect(
         ReferralAbuseService.evaluate({
            referrerAddress: REFERRER,
            refereeAddress: REFEREE,
         })
      ).resolves.toEqual({ action: 'allow' });
   });

   it('does not reject when the funders differ', async () => {
      fundings({
         [REFERRER]: { funder: 'GFUNDERA', fundedAt: at(-500) },
         [REFEREE]: { funder: 'GFUNDERB', fundedAt: T0 },
      });
      const decision = await ReferralAbuseService.evaluate({
         referrerAddress: REFERRER,
         refereeAddress: REFEREE,
      });
      expect(decision.action).toBe('allow');
   });
});

describe('funding cluster', () => {
   beforeEach(() => {
      fundings({
         [REFERRER]: { funder: 'GUNRELATED', fundedAt: at(-900) },
         [REFEREE]: { funder: FUNDER, fundedAt: T0 },
      });
   });

   it('holds when more than 5 referees were funded by one account within 24 hours', async () => {
      seedCluster(clusterRows(CLUSTER_THRESHOLD + 1, 1)); // 6 within 5 hours
      const decision = await ReferralAbuseService.evaluate({
         referrerAddress: REFERRER,
         refereeAddress: REFEREE,
      });
      expect(decision).toEqual({
         action: 'hold',
         reason: 'FUNDING_CLUSTER',
         details: {
            funder: FUNDER,
            refereesInWindow: 6,
            threshold: 5,
            windowHours: 24,
         },
      });
   });

   it('allows exactly 5 referees from one funder', async () => {
      seedCluster(clusterRows(5, 1));
      const decision = await ReferralAbuseService.evaluate({
         referrerAddress: REFERRER,
         refereeAddress: REFEREE,
      });
      expect(decision.action).toBe('allow');
   });

   it('allows many referees from one funder spread over more than 24 hours', async () => {
      seedCluster(clusterRows(8, 10)); // one every 10h: at most 3 per 24h
      const decision = await ReferralAbuseService.evaluate({
         referrerAddress: REFERRER,
         refereeAddress: REFEREE,
      });
      expect(decision.action).toBe('allow');
   });

   it('only counts funded wallets that are referees', async () => {
      const rows = clusterRows(8, 1);
      sourcesFindMany.mockResolvedValue(rows);
      // Only 4 of the 8 funded wallets ever registered as referees.
      referralFindMany.mockResolvedValue(
         rows.slice(0, 4).map(r => ({ refereeAddress: r.address }))
      );
      const decision = await ReferralAbuseService.evaluate({
         referrerAddress: REFERRER,
         refereeAddress: REFEREE,
      });
      expect(decision.action).toBe('allow');
   });

   it('counts the referee itself when its funding row is not yet in the table', async () => {
      // 5 other referees + this one = 6.
      seedCluster(clusterRows(6, 1).slice(1));
      const decision = await ReferralAbuseService.evaluate({
         referrerAddress: REFERRER,
         refereeAddress: REFEREE,
      });
      expect(decision).toMatchObject({
         action: 'hold',
         reason: 'FUNDING_CLUSTER',
      });
   });

   it('does not hold a cluster funded by an allowlisted account', async () => {
      config.REFERRAL_ABUSE_FUNDER_ALLOWLIST = FUNDER;
      seedCluster(clusterRows(10, 1));
      const decision = await ReferralAbuseService.evaluate({
         referrerAddress: REFERRER,
         refereeAddress: REFEREE,
      });
      expect(decision.action).toBe('allow');
      expect(sourcesFindMany).not.toHaveBeenCalled();
   });
});

describe('normal referrals', () => {
   it('allows a referral whose funding is unknown for both wallets', async () => {
      fundings({});
      await expect(
         ReferralAbuseService.evaluate({
            referrerAddress: REFERRER,
            refereeAddress: REFEREE,
         })
      ).resolves.toEqual({ action: 'allow' });
   });

   it('allows an ordinary referral with unrelated funders and no cluster', async () => {
      fundings({
         [REFERRER]: { funder: 'GA', fundedAt: at(-900) },
         [REFEREE]: { funder: 'GB', fundedAt: T0 },
      });
      seedCluster([{ address: REFEREE, fundedAt: T0 }]);
      await expect(
         ReferralAbuseService.evaluate({
            referrerAddress: REFERRER,
            refereeAddress: REFEREE,
         })
      ).resolves.toEqual({ action: 'allow' });
   });

   it('propagates funding lookup failures instead of allowing', async () => {
      getFunding.mockRejectedValue(new Error('Horizon unavailable'));
      await expect(
         ReferralAbuseService.evaluate({
            referrerAddress: REFERRER,
            refereeAddress: REFEREE,
         })
      ).rejects.toThrow('Horizon unavailable');
   });
});

describe('window helpers', () => {
   it('counts times inside a 24h window that contains the anchor', () => {
      // 0h..24h fits in one window: the 24h boundary is inclusive.
      expect(densestWindowCount([0, 5, 10, 23, 24].map(at), at(24))).toBe(5);
      // 24.01h is just outside the window that starts at 0h.
      expect(densestWindowCount([0, 5, 10, 23, 24.01].map(at), at(24.01))).toBe(
         4
      );
   });

   it('ignores windows that do not contain the anchor', () => {
      const dense = [0, 1, 2, 3, 4, 5].map(at);
      expect(hasDenseWindow(dense, at(100))).toBe(false);
      expect(hasDenseWindow([...dense, at(100)], at(100))).toBe(false);
      expect(hasDenseWindow(dense, at(3))).toBe(true);
   });

   it('is order independent and handles empty input', () => {
      expect(hasDenseWindow([], T0)).toBe(false);
      expect(hasDenseWindow([5, 1, 4, 0, 3, 2].map(at), at(2))).toBe(true);
   });
});
