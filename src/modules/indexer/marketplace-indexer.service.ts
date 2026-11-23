import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { StrKey } from '@stellar/stellar-base';
import { resolveCreatorId } from '../whitelist/whitelist.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { chainPositionSchema, eventIdentifierSchema, eventOccurredAt } from '../../utils/indexer-event-fields.utils';
import { IndexerChainEvent, processIndexerChainEvents } from '../../utils/indexer-event-processor.utils';
import { MARKETPLACE_CACHE_KEY } from '../marketplaces/marketplace.service';

export const MARKETPLACE_EVENT_TYPES = [
   'marketplace_approved', 'MARKETPLACE_APPROVED', 'MarketplaceApproved',
   'marketplace_revoked', 'MARKETPLACE_REVOKED', 'MarketplaceRevoked',
   'royalty_enforcement_set', 'ROYALTY_ENFORCEMENT_SET', 'RoyaltyEnforcementSet',
];
const kinds = new Set(['marketplaceapproved', 'marketplacerevoked', 'royaltyenforcementset']);
export const isMarketplaceEventType = (eventType: string): boolean =>
   kinds.has(eventType.replace(/[^a-z]/gi, '').toLowerCase());

const addressSchema = z.string().trim().refine(value =>
   StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value),
   'Invalid Stellar account or contract address');
const enforcementSchema = z.object({
   keyId: eventIdentifierSchema,
   royaltyEnforced: z.boolean(),
   locked: z.boolean(),
});

interface Position {
   ledger: number;
   eventIndex: number;
   transactionIndex: number | null;
}

/** Missing transaction index uses the ingestion stream's order within a ledger. */
function newerPosition(position: Position & { txHash: string }) {
   const sameTransaction = {
      ledger: position.ledger, txHash: position.txHash,
      eventIndex: { lt: position.eventIndex },
   };
   if (position.transactionIndex === null) {
      return [
         { ledger: { lt: position.ledger } },
         sameTransaction,
         { ledger: position.ledger, txHash: { not: position.txHash } },
      ];
   }
   return [
      { ledger: { lt: position.ledger } },
      sameTransaction,
      { ledger: position.ledger, txHash: { not: position.txHash }, transactionIndex: null },
      { ledger: position.ledger, txHash: { not: position.txHash }, transactionIndex: { lt: position.transactionIndex } },
   ];
}

async function applyRegistryEvent(
   kind: string,
   position: Position & { txHash: string },
   address: string | null,
   enforcement: z.infer<typeof enforcementSchema> | null,
   occurredAt: Date
): Promise<void> {
   await prisma.$transaction(async tx => {
      const inserted = await tx.marketplaceRegistryEvent.createMany({
         data: [{ eventType: kind, ...position }],
         skipDuplicates: true,
      });
      if (inserted.count === 0) return;
      if (enforcement) {
         await tx.keyRoyaltyEnforcement.upsert({
            where: { keyId: enforcement.keyId },
            create: { keyId: enforcement.keyId },
            update: {},
         });
         await tx.keyRoyaltyEnforcement.updateMany({
            where: { keyId: enforcement.keyId, OR: newerPosition(position) },
            data: { ...enforcement, ...position },
         });
      } else if (address) {
         await tx.approvedMarketplace.upsert({
            where: { address }, create: { address }, update: {},
         });
         await tx.approvedMarketplace.updateMany({
            where: { address, OR: newerPosition(position) },
            data: {
               approved: kind === 'marketplaceapproved',
               ...(kind === 'marketplaceapproved' ? { approvedAt: occurredAt } : {}),
               ...position,
            },
         });
      }
   }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
   // Replays also invalidate: retrying after a failed invalidation must recover.
   await cacheInvalidate(MARKETPLACE_CACHE_KEY);
}

export async function processMarketplaceEvents(events: IndexerChainEvent[]): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!isMarketplaceEventType(event.eventType)) return;
      const kind = event.eventType.replace(/[^a-z]/gi, '').toLowerCase();
      const chain = chainPositionSchema.parse(event);
      const transactionIndex = z.number().int().nonnegative().nullable().parse(
         event.transactionIndex ?? event.txIndex ?? null);
      const position = { ...chain, transactionIndex };
      const parsedEnforcement = kind === 'royaltyenforcementset'
         ? enforcementSchema.parse({
            keyId: event.creatorId ?? event.creator_id ?? event.keyId ?? event.key_id,
            royaltyEnforced: event.royaltyEnforced ?? event.royalty_enforced ?? event.enforced,
            locked: event.locked ?? event.isLocked ?? event.is_locked,
         }) : null;
      const enforcement = parsedEnforcement ? {
         ...parsedEnforcement,
         keyId: (await resolveCreatorId(parsedEnforcement.keyId)) ?? parsedEnforcement.keyId,
      } : null;
      const address = enforcement ? null : addressSchema.parse(
         event.address ?? event.marketplace ?? event.marketplaceAddress ?? event.marketplace_address);
      const occurredAt = eventOccurredAt({
         ...event, timestamp: event.timestamp ?? event.occurredAt ?? event.ledgerClosedAt,
      });
      await applyRegistryEvent(kind, position, address, enforcement, occurredAt);
   });
}
