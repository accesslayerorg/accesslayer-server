const mockFindWindow = jest.fn();
const mockFindCommit = jest.fn();
const mockFindLedger = jest.fn();

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      launchWindow: { findUnique: (...args: any[]) => mockFindWindow(...args) },
      launchCommit: { findUnique: (...args: any[]) => mockFindCommit(...args) },
      indexedLedger: { findUnique: (...args: any[]) => mockFindLedger(...args) },
   },
}));

import {
   CommitRevealLaunchService,
   computeLaunchPhase,
   LaunchWindowNotFoundError,
} from './commit-reveal-launch.service';

describe('CommitRevealLaunchService (#1264)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('computes phase from current ledger relative to configured windows', () => {
      const win = {
         phase: 'commit',
         commitEndLedger: 150,
         revealEndLedger: 200,
         clearingPrice: null,
      };
      expect(computeLaunchPhase(win, 120)).toEqual({
         phase: 'commit',
         ledgersRemaining: 30,
      });
      expect(computeLaunchPhase(win, 160)).toEqual({
         phase: 'reveal',
         ledgersRemaining: 40,
      });
      expect(computeLaunchPhase(win, 205)).toEqual({
         phase: 'settled',
         ledgersRemaining: 0,
      });
   });

   it('throws LaunchWindowNotFoundError (404) when key has no launch window', async () => {
      mockFindWindow.mockResolvedValue(null);
      await expect(CommitRevealLaunchService.getStatus('missing')).rejects.toThrow(
         LaunchWindowNotFoundError
      );
      await expect(
         CommitRevealLaunchService.getWalletStatus('missing', 'GWALLET')
      ).rejects.toThrow(LaunchWindowNotFoundError);
   });

   it('shows unrevealed commitments as pending on wallet endpoint', async () => {
      mockFindWindow.mockResolvedValue({
         keyId: 'key-1',
         phase: 'commit',
         commitEndLedger: 150,
         revealEndLedger: 200,
         clearingPrice: null,
         commitCount: 1,
         revealCount: 0,
      });
      mockFindLedger.mockResolvedValue({ ledger: 130 });
      mockFindCommit.mockResolvedValue({
         keyId: 'key-1',
         wallet: 'GWALLET1',
         commitment: '0xabc',
         revealed: false,
         fillStatus: 'pending',
         amount: null,
         maxPrice: null,
         filledAmount: null,
      });

      const res = await CommitRevealLaunchService.getWalletStatus('key-1', 'GWALLET1');
      expect(res.phase).toBe('commit');
      expect(res.ledgersRemaining).toBe(20);
      expect(res.committed).toBe(true);
      expect(res.revealed).toBe(false);
      expect(res.fillStatus).toBe('pending');
   });
});
