const mockFindManyEvents = jest.fn();
const mockFindUniqueEvent = jest.fn();
const mockFindLedger = jest.fn();
const mockFindOwnership = jest.fn();
const mockFindRedemption = jest.fn();
const mockFindManyRedemptions = jest.fn();

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      passEvent: {
         findMany: (...args: any[]) => mockFindManyEvents(...args),
         findUnique: (...args: any[]) => mockFindUniqueEvent(...args),
      },
      indexedLedger: {
         findUnique: (...args: any[]) => mockFindLedger(...args),
      },
      keyOwnership: {
         findUnique: (...args: any[]) => mockFindOwnership(...args),
      },
      passRedemption: {
         findUnique: (...args: any[]) => mockFindRedemption(...args),
         findMany: (...args: any[]) => mockFindManyRedemptions(...args),
      },
   },
}));

jest.mock('../../config', () => ({
   envConfig: { APP_SECRET: 'test-secret-key-for-pass-events-00000' },
}));

import {
   computePassEventStatus,
   PassEventForbiddenError,
   PassEventsService,
} from './pass-events.service';

describe('PassEventsService (#1332)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('computes upcoming, open, full, ended, and closed statuses correctly', () => {
      const base = {
         closed: false,
         startLedger: 100,
         endLedger: 200,
         capacity: 10,
         redeemedCount: 3,
      };
      expect(computePassEventStatus(base, 50)).toBe('upcoming');
      expect(computePassEventStatus(base, 150)).toBe('open');
      expect(computePassEventStatus({ ...base, redeemedCount: 10 }, 150)).toBe('full');
      expect(computePassEventStatus(base, 250)).toBe('ended');
      // Closed always reports closed regardless of window
      expect(computePassEventStatus({ ...base, closed: true }, 50)).toBe('closed');
      expect(computePassEventStatus({ ...base, closed: true }, 150)).toBe('closed');
      expect(computePassEventStatus({ ...base, closed: true }, 250)).toBe('closed');
   });

   it('reports eligibility reasons for every rule failure', async () => {
      mockFindUniqueEvent.mockResolvedValue({
         id: 'evt-1',
         keyId: 'key-1',
         creatorWallet: 'GCREATOR',
         startLedger: 100,
         endLedger: 200,
         capacity: 5,
         redeemedCount: 5,
         minBalance: '10',
         closed: true,
      });
      mockFindLedger.mockResolvedValue({ ledger: 250 });
      mockFindOwnership.mockResolvedValue({ balance: '2' });
      mockFindRedemption.mockResolvedValue({ id: 'pr-1' });

      const res = await PassEventsService.checkEligibility('evt-1', 'GHOLDER');
      expect(res.eligible).toBe(false);
      expect(res.status).toBe('closed');
      expect(res.reasons).toEqual([
         'event_closed',
         'outside_window',
         'capacity_full',
         'already_redeemed',
         'insufficient_balance',
      ]);
   });

   it('returns eligible: true when all checks pass', async () => {
      mockFindUniqueEvent.mockResolvedValue({
         id: 'evt-1',
         keyId: 'key-1',
         creatorWallet: 'GCREATOR',
         startLedger: 100,
         endLedger: 200,
         capacity: 5,
         redeemedCount: 1,
         minBalance: '10',
         closed: false,
      });
      mockFindLedger.mockResolvedValue({ ledger: 150 });
      mockFindOwnership.mockResolvedValue({ balance: '15' });
      mockFindRedemption.mockResolvedValue(null);

      const res = await PassEventsService.checkEligibility('evt-1', 'GHOLDER');
      expect(res.eligible).toBe(true);
      expect(res.status).toBe('open');
      expect(res.reasons).toEqual([]);
   });

   it('paginates redemptions with a stable cursor and enforces creator access', async () => {
      mockFindUniqueEvent.mockResolvedValue({
         id: 'evt-1',
         creatorWallet: 'GCREATOR',
      });

      await expect(
         PassEventsService.listRedemptions('evt-1', 'GOTHER')
      ).rejects.toThrow(PassEventForbiddenError);

      mockFindManyRedemptions.mockResolvedValueOnce([
         { id: 'r3', ledger: 130, wallet: 'W3' },
         { id: 'r2', ledger: 120, wallet: 'W2' },
         { id: 'r1', ledger: 110, wallet: 'W1' },
      ]);

      const page1 = await PassEventsService.listRedemptions(
         'evt-1',
         'GCREATOR',
         undefined,
         2
      );
      expect(page1.redemptions).toHaveLength(2);
      expect(page1.cursor).toBeTruthy();

      mockFindManyRedemptions.mockResolvedValueOnce([
         { id: 'r1', ledger: 110, wallet: 'W1' },
      ]);

      const page2 = await PassEventsService.listRedemptions(
         'evt-1',
         'GCREATOR',
         page1.cursor!,
         2
      );
      expect(page2.redemptions).toHaveLength(1);
      expect(page2.cursor).toBeNull();
   });
});
