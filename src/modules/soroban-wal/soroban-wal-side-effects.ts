import { SorobanWALEntry } from './soroban-wal.types';
import { SorobanWALDatabaseTransaction } from './prisma-soroban-wal.store';

interface SideEffectTransaction extends SorobanWALDatabaseTransaction {
   creatorProfile: any;
   keyOwnership: any;
   creatorPriceSnapshot: any;
   activity: any;
   activityLog: any;
}

export async function applyDefaultSorobanSideEffects(
   databaseTransaction: unknown,
   entry: SorobanWALEntry
): Promise<void> {
   const transaction = databaseTransaction as SideEffectTransaction;
   const creator = await transaction.creatorProfile.findFirst({
      where: {
         user: {
            is: {
               stellarWallet: { is: { address: entry.creatorWallet } },
            },
         },
      },
      select: { id: true, circulatingSupply: true },
   });

   if (!creator) {
      throw new Error(
         `Creator profile for wallet ${entry.creatorWallet} was not found`
      );
   }

   if (creator.circulatingSupply.toString() !== entry.expectedSupplyBefore) {
      throw new Error(
         `Supply changed before confirmation for WAL entry ${entry.id}`
      );
   }

   const amount = entry.amount;
   const delta = entry.operation === 'BUY' ? amount : `-${amount}`;
   const confirmedAt = new Date();

   await transaction.keyOwnership.upsert({
      where: {
         ownerAddress_creatorId: {
            ownerAddress: entry.wallet,
            creatorId: creator.id,
         },
      },
      create: {
         ownerAddress: entry.wallet,
         creatorId: creator.id,
         balance: delta,
         lastBuyAt: entry.operation === 'BUY' ? confirmedAt : null,
      },
      update: {
         balance: { increment: delta },
         ...(entry.operation === 'BUY' ? { lastBuyAt: confirmedAt } : {}),
      },
   });

   await transaction.creatorProfile.update({
      where: { id: creator.id },
      data: { circulatingSupply: { increment: delta } },
   });

   await transaction.creatorPriceSnapshot.upsert({
      where: { creatorId: creator.id },
      create: { creatorId: creator.id, lastTradeAt: confirmedAt },
      update: { lastTradeAt: confirmedAt },
   });

   await transaction.activity.create({
      data: {
         type: entry.operation === 'BUY' ? 'KEY_BOUGHT' : 'KEY_SOLD',
         actor: entry.wallet,
         creatorId: creator.id,
         payload: { amount, txHash: entry.txHash },
         createdAt: confirmedAt,
      },
   });

   await transaction.activityLog.create({
      data: {
         type: entry.operation.toLowerCase(),
         actor: entry.wallet,
         keyId: creator.id,
         amount,
         txHash: entry.txHash,
         timestamp: confirmedAt,
      },
   });
}
