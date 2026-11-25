// src/modules/indexer/conviction-indexer.service.ts
// Idempotent indexer for conviction voting stakes and rage-quit exits (#1306).

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   getChainEventId,
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import { convictionService } from '../governance/conviction.service';

export const CONVICTION_EVENT_TYPES = new Set([
   'staked',
   'STAKED',
   'ConvictionStaked',
   'unstaked',
   'UNSTAKED',
   'ConvictionUnstaked',
   'proposal_executed',
   'PROPOSAL_EXECUTED',
   'ProposalExecuted',
   'ragequit',
   'RAGEQUIT',
   'RagequitExited',
]);

export function isConvictionEvent(event: IndexerChainEvent): boolean {
   return CONVICTION_EVENT_TYPES.has(event.eventType);
}

function toBigIntSafe(val: unknown): bigint {
   if (val === undefined || val === null || val === '') return 0n;
   return BigInt(String(val));
}

export async function processConvictionEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!isConvictionEvent(event)) return;

      const raw = event as Record<string, unknown>;
      const proposalId =
         typeof raw.proposalId === 'string' && raw.proposalId.trim().length > 0
            ? raw.proposalId.trim()
            : null;
      const keyId =
         typeof raw.keyId === 'string' && raw.keyId.trim().length > 0
            ? raw.keyId.trim()
            : 'unknown';
      const ledger = typeof event.ledger === 'number' ? event.ledger : 0;
      const eventId = getChainEventId(event);
      const typeLower = event.eventType.toLowerCase();

      if (!proposalId) {
         logger.warn(
            { eventType: event.eventType, eventId },
            'Skipping conviction event without proposalId'
         );
         return;
      }

      // Idempotency check via ConvictionSnapshot unique (txHash, eventIndex)
      const existingSnap = await prisma.convictionSnapshot.findUnique({
         where: {
            txHash_eventIndex: {
               txHash: event.txHash,
               eventIndex: event.eventIndex,
            },
         },
      });
      if (existingSnap) {
         return;
      }

      const wallet =
         typeof raw.wallet === 'string'
            ? raw.wallet.trim()
            : typeof raw.voter === 'string'
              ? raw.voter.trim()
              : null;

      if (typeLower === 'staked' || typeLower === 'convictionstaked') {
         if (!wallet) return;
         const amount = toBigIntSafe(raw.amount);
         const threshold = toBigIntSafe(raw.threshold);

         const existingStake = await prisma.convictionStake.findUnique({
            where: { proposalId_wallet: { proposalId, wallet } },
         });
         if (existingStake?.lastEventId === eventId) return;

         const newAmount = existingStake?.isActive
            ? existingStake.amount + amount
            : amount;

         await prisma.convictionStake.upsert({
            where: { proposalId_wallet: { proposalId, wallet } },
            create: {
               proposalId,
               keyId,
               wallet,
               amount: newAmount,
               stakedAtLedger: ledger,
               isActive: true,
               lastEventId: eventId,
            },
            update: {
               amount: newAmount,
               isActive: true,
               unstakedAtLedger: null,
               lastEventId: eventId,
            },
         });

         const active = await prisma.convictionStake.findMany({
            where: { proposalId, isActive: true },
            select: { amount: true },
         });
         const totalStaked = active.reduce((s, r) => s + r.amount, 0n);

         await prisma.convictionSnapshot.create({
            data: {
               proposalId,
               keyId,
               ledger,
               totalStaked,
               conviction: toBigIntSafe(raw.conviction),
               threshold,
               executed: false,
               txHash: event.txHash,
               eventIndex: event.eventIndex,
            },
         });

         await convictionService.invalidateProposalCache(proposalId);
         return;
      }

      if (typeLower === 'unstaked' || typeLower === 'convictionunstaked') {
         if (!wallet) return;
         const amount = toBigIntSafe(raw.amount);
         const threshold = toBigIntSafe(raw.threshold);

         const existingStake = await prisma.convictionStake.findUnique({
            where: { proposalId_wallet: { proposalId, wallet } },
         });
         if (existingStake?.lastEventId === eventId) return;

         if (existingStake) {
            const remaining =
               amount > 0n && existingStake.amount > amount
                  ? existingStake.amount - amount
                  : 0n;
            await prisma.convictionStake.update({
               where: { proposalId_wallet: { proposalId, wallet } },
               data: {
                  amount: remaining,
                  isActive: remaining > 0n,
                  unstakedAtLedger: remaining === 0n ? ledger : null,
                  lastEventId: eventId,
               },
            });
         }

         const active = await prisma.convictionStake.findMany({
            where: { proposalId, isActive: true },
            select: { amount: true },
         });
         const totalStaked = active.reduce((s, r) => s + r.amount, 0n);

         await prisma.convictionSnapshot.create({
            data: {
               proposalId,
               keyId,
               ledger,
               totalStaked,
               conviction: toBigIntSafe(raw.conviction),
               threshold,
               executed: false,
               txHash: event.txHash,
               eventIndex: event.eventIndex,
            },
         });

         await convictionService.invalidateProposalCache(proposalId);
         return;
      }

      if (typeLower === 'proposal_executed' || typeLower === 'proposalexecuted') {
         const active = await prisma.convictionStake.findMany({
            where: { proposalId, isActive: true },
            select: { amount: true },
         });
         const totalStaked = active.reduce((s, r) => s + r.amount, 0n);

         await prisma.convictionSnapshot.create({
            data: {
               proposalId,
               keyId,
               ledger,
               totalStaked,
               conviction: toBigIntSafe(raw.conviction),
               threshold: toBigIntSafe(raw.threshold),
               executed: true,
               txHash: event.txHash,
               eventIndex: event.eventIndex,
            },
         });

         await convictionService.invalidateProposalCache(proposalId);
         return;
      }

      if (typeLower === 'ragequit' || typeLower === 'ragequitexited') {
         if (!wallet) return;
         const amount = toBigIntSafe(raw.amount);

         await prisma.ragequitExit.upsert({
            where: {
               txHash_eventIndex: {
                  txHash: event.txHash,
                  eventIndex: event.eventIndex,
               },
            },
            create: {
               proposalId,
               keyId,
               wallet,
               amount,
               ledger,
               txHash: event.txHash,
               eventIndex: event.eventIndex,
            },
            update: {},
         });

         await prisma.convictionStake.updateMany({
            where: { proposalId, wallet, isActive: true },
            data: {
               amount: 0n,
               isActive: false,
               unstakedAtLedger: ledger,
               lastEventId: eventId,
            },
         });

         await convictionService.invalidateProposalCache(proposalId);
      }
   });
}
