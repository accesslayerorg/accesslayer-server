import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';

export const BUY_COMMITTED_EVENT_TYPES = new Set([
   'buy_committed',
   'BuyCommitted',
   'BUY_COMMITTED',
]);

export const BUY_REVEALED_EVENT_TYPES = new Set([
   'buy_revealed',
   'BuyRevealed',
   'BUY_REVEALED',
]);

export const LAUNCH_SETTLED_EVENT_TYPES = new Set([
   'launch_settled',
   'LaunchSettled',
   'LAUNCH_SETTLED',
]);

export const COMMIT_REVEAL_LAUNCH_EVENT_TYPES = new Set([
   ...BUY_COMMITTED_EVENT_TYPES,
   ...BUY_REVEALED_EVENT_TYPES,
   ...LAUNCH_SETTLED_EVENT_TYPES,
]);

function requiredString(event: IndexerChainEvent, ...fields: string[]): string {
   for (const field of fields) {
      const value = event[field];
      if (value != null && String(value).trim() !== '') {
         return String(value).trim();
      }
   }
   throw new Error(`Invalid ${event.eventType}: ${fields[0]} is required`);
}

function optionalInt(event: IndexerChainEvent, ...fields: string[]): number | undefined {
   for (const field of fields) {
      const value = event[field];
      if (value != null && Number.isInteger(Number(value))) {
         return Number(value);
      }
   }
   return undefined;
}

function optionalDecimalString(
   event: IndexerChainEvent,
   ...fields: string[]
): string | undefined {
   for (const field of fields) {
      const value = event[field];
      if (value != null && String(value).trim() !== '' && !Number.isNaN(Number(value))) {
         return String(value).trim();
      }
   }
   return undefined;
}

async function handleBuyCommitted(event: IndexerChainEvent): Promise<void> {
   const keyId = requiredString(event, 'keyId', 'creatorId');
   const wallet = requiredString(event, 'wallet', 'buyer', 'actor');
   const commitment = requiredString(event, 'commitment', 'commitHash');
   const commitEndLedger = optionalInt(event, 'commitEndLedger') ?? (event.ledger ?? 0) + 100;
   const revealEndLedger = optionalInt(event, 'revealEndLedger') ?? commitEndLedger + 100;

   await prisma.$transaction(async tx => {
      const window = await tx.launchWindow.upsert({
         where: { keyId },
         create: {
            keyId,
            phase: 'commit',
            commitEndLedger,
            revealEndLedger,
         },
         update: {},
      });

      const existingByTx = await tx.launchCommit.findUnique({
         where: {
            commitTxHash_commitEventIndex: {
               commitTxHash: event.txHash,
               commitEventIndex: event.eventIndex,
            },
         },
      });
      if (existingByTx) {
         return;
      }

      const existingByWallet = await tx.launchCommit.findUnique({
         where: {
            keyId_wallet: { keyId, wallet },
         },
      });
      if (existingByWallet) {
         return;
      }

      await tx.launchCommit.create({
         data: {
            launchWindowId: window.id,
            keyId,
            wallet,
            commitment,
            revealed: false,
            fillStatus: 'pending',
            commitTxHash: event.txHash,
            commitEventIndex: event.eventIndex,
            commitLedger: event.ledger ?? 0,
         },
      });

      await tx.launchWindow.update({
         where: { id: window.id },
         data: { commitCount: { increment: 1 } },
      });
   });
}

async function handleBuyRevealed(event: IndexerChainEvent): Promise<void> {
   const keyId = requiredString(event, 'keyId', 'creatorId');
   const wallet = requiredString(event, 'wallet', 'buyer', 'actor');
   const amount = optionalDecimalString(event, 'amount', 'quantity');
   const maxPrice = optionalDecimalString(event, 'maxPrice', 'price');

   await prisma.$transaction(async tx => {
      const commit = await tx.launchCommit.findUnique({
         where: { keyId_wallet: { keyId, wallet } },
      });

      if (!commit) {
         logger.warn(
            { keyId, wallet, txHash: event.txHash },
            'buy_revealed received for unknown launch commitment'
         );
         return;
      }

      if (commit.revealed) {
         return;
      }

      await tx.launchCommit.update({
         where: { id: commit.id },
         data: {
            revealed: true,
            amount: amount ?? null,
            maxPrice: maxPrice ?? null,
            fillStatus: 'revealed',
            revealTxHash: event.txHash,
            revealEventIndex: event.eventIndex,
            revealLedger: event.ledger,
         },
      });

      await tx.launchWindow.update({
         where: { id: commit.launchWindowId },
         data: {
            revealCount: { increment: 1 },
         },
      });

      await tx.launchWindow.updateMany({
         where: { id: commit.launchWindowId, phase: 'commit' },
         data: { phase: 'reveal' },
      });
   });
}

async function handleLaunchSettled(event: IndexerChainEvent): Promise<void> {
   const keyId = requiredString(event, 'keyId', 'creatorId');
   const clearingPrice = requiredString(event, 'clearingPrice', 'price');

   await prisma.$transaction(async tx => {
      const window = await tx.launchWindow.findUnique({
         where: { keyId },
      });
      if (!window) {
         logger.warn(
            { keyId, txHash: event.txHash },
            'launch_settled received for unknown launch window'
         );
         return;
      }

      const updated = await tx.launchWindow.updateMany({
         where: { id: window.id, phase: { not: 'settled' } },
         data: {
            phase: 'settled',
            clearingPrice,
            settledTxHash: event.txHash,
            settledEventIndex: event.eventIndex,
         },
      });

      if (updated.count === 0) {
         return;
      }

      const revealedCommits = await tx.launchCommit.findMany({
         where: { launchWindowId: window.id, revealed: true },
      });

      const clearingNum = Number(clearingPrice);
      for (const commit of revealedCommits) {
         const maxPriceNum =
            commit.maxPrice != null ? Number(commit.maxPrice) : clearingNum;
         const isFilled = maxPriceNum >= clearingNum;

         await tx.launchCommit.update({
            where: { id: commit.id },
            data: {
               fillStatus: isFilled ? 'filled' : 'unfilled',
               filledAmount: isFilled ? (commit.amount ?? '0') : '0',
            },
         });
      }
   });
}

export async function processCommitRevealLaunchEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (BUY_COMMITTED_EVENT_TYPES.has(event.eventType)) {
         await handleBuyCommitted(event);
      } else if (BUY_REVEALED_EVENT_TYPES.has(event.eventType)) {
         await handleBuyRevealed(event);
      } else if (LAUNCH_SETTLED_EVENT_TYPES.has(event.eventType)) {
         await handleLaunchSettled(event);
      }
   });
}
