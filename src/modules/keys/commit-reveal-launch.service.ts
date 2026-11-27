import { prisma } from '../../utils/prisma.utils';

export type CommitRevealPhase = 'commit' | 'reveal' | 'settled';

export class LaunchWindowNotFoundError extends Error {
   constructor(keyId: string) {
      super(`No launch window found for key ${keyId}`);
      this.name = 'LaunchWindowNotFoundError';
   }
}

export function computeLaunchPhase(
   window: {
      phase: string;
      commitEndLedger: number;
      revealEndLedger: number;
      clearingPrice: unknown;
   },
   currentLedger: number
): { phase: CommitRevealPhase; ledgersRemaining: number } {
   if (window.phase === 'settled' || window.clearingPrice != null) {
      return { phase: 'settled', ledgersRemaining: 0 };
   }

   if (currentLedger <= window.commitEndLedger) {
      return {
         phase: 'commit',
         ledgersRemaining: Math.max(0, window.commitEndLedger - currentLedger),
      };
   }

   if (currentLedger <= window.revealEndLedger) {
      return {
         phase: 'reveal',
         ledgersRemaining: Math.max(0, window.revealEndLedger - currentLedger),
      };
   }

   return { phase: 'settled', ledgersRemaining: 0 };
}

async function getCurrentLedger(): Promise<number> {
   const row = await prisma.indexedLedger.findUnique({
      where: { id: 1 },
      select: { ledger: true },
   });
   return row?.ledger ?? 0;
}

export class CommitRevealLaunchService {
   static async getStatus(keyId: string) {
      const window = await prisma.launchWindow.findUnique({
         where: { keyId },
      });
      if (!window) {
         throw new LaunchWindowNotFoundError(keyId);
      }

      const currentLedger = await getCurrentLedger();
      const { phase, ledgersRemaining } = computeLaunchPhase(
         window,
         currentLedger
      );

      return {
         keyId: window.keyId,
         phase,
         currentLedger,
         commitEndLedger: window.commitEndLedger,
         revealEndLedger: window.revealEndLedger,
         ledgersRemaining,
         clearingPrice:
            window.clearingPrice != null ? String(window.clearingPrice) : null,
         counts: {
            commits: window.commitCount,
            reveals: window.revealCount,
         },
      };
   }

   static async getWalletStatus(keyId: string, wallet: string) {
      const window = await prisma.launchWindow.findUnique({
         where: { keyId },
      });
      if (!window) {
         throw new LaunchWindowNotFoundError(keyId);
      }

      const currentLedger = await getCurrentLedger();
      const { phase, ledgersRemaining } = computeLaunchPhase(
         window,
         currentLedger
      );

      const commit = await prisma.launchCommit.findUnique({
         where: { keyId_wallet: { keyId, wallet } },
      });

      if (!commit) {
         return {
            keyId,
            wallet,
            phase,
            ledgersRemaining,
            committed: false,
            revealed: false,
            fillStatus: 'none',
            commitment: null,
            amount: null,
            maxPrice: null,
            filledAmount: null,
            clearingPrice:
               window.clearingPrice != null
                  ? String(window.clearingPrice)
                  : null,
         };
      }

      return {
         keyId,
         wallet,
         phase,
         ledgersRemaining,
         committed: true,
         revealed: commit.revealed,
         fillStatus: commit.revealed ? commit.fillStatus : 'pending',
         commitment: commit.commitment,
         amount: commit.amount != null ? String(commit.amount) : null,
         maxPrice: commit.maxPrice != null ? String(commit.maxPrice) : null,
         filledAmount:
            commit.filledAmount != null ? String(commit.filledAmount) : null,
         clearingPrice:
            window.clearingPrice != null ? String(window.clearingPrice) : null,
      };
   }
}
