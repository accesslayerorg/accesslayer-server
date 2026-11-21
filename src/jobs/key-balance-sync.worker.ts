import { prisma } from '../utils/prisma.utils';
import { logger } from '../utils/logger.utils';

export interface BalanceRecord {
   id: string;
   ownerAddress: string;
   creatorId: string;
   balance: { toString(): string } | number;
}

export interface KeyBalanceSyncDependencies {
   listBalances(): Promise<BalanceRecord[]>;
   getOnChainBalance(
      ownerAddress: string,
      creatorId: string
   ): Promise<number | null>;
   updateBalance(id: string, balance: number): Promise<void>;
   logCorrection(fields: {
      ownerAddress: string;
      creatorId: string;
      oldBalance: number;
      newBalance: number;
   }): void;
}

export async function runKeyBalanceSync(
   dependencies: KeyBalanceSyncDependencies
): Promise<number> {
   const records = await dependencies.listBalances();
   let corrected = 0;

   for (const record of records) {
      const oldBalance = Number(record.balance.toString());
      const newBalance =
         (await dependencies.getOnChainBalance(
            record.ownerAddress,
            record.creatorId
         )) ?? 0;
      if (oldBalance === newBalance) continue;

      await dependencies.updateBalance(record.id, newBalance);
      dependencies.logCorrection({
         ownerAddress: record.ownerAddress,
         creatorId: record.creatorId,
         oldBalance,
         newBalance,
      });
      corrected += 1;
   }

   return corrected;
}

export interface OnChainKeyBalanceReader {
   getBalance(ownerAddress: string, creatorId: string): Promise<number | null>;
}

export async function syncKeyBalances(
   reader: OnChainKeyBalanceReader
): Promise<number> {
   return runKeyBalanceSync({
      listBalances: () => prisma.keyOwnership.findMany(),
      getOnChainBalance: (ownerAddress, creatorId) =>
         reader.getBalance(ownerAddress, creatorId),
      updateBalance: async (id, balance) => {
         const corrected = await prisma.keyOwnership.update({
            where: { id },
            data: { balance },
         });
         const { onHolderBalanceChanged } = await import('../modules/keys/key-holder-leaderboard.service');
         await onHolderBalanceChanged(corrected.creatorId);
      },
      logCorrection: fields => {
         logger.info(fields, 'Corrected stale key balance from on-chain state');
      },
   });
}
