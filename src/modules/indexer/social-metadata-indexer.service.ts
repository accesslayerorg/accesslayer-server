// src/modules/indexer/social-metadata-indexer.service.ts
//
// Indexes SOCIAL_METADATA_UPDATED events emitted by the social metadata
// extension contract and syncs them into the API-layer cache.
//
// Per event the handler:
// 1. Validates required fields (warn-and-skip, mirroring the trade pipeline).
// 2. Guards against duplicates via the (txHash, eventIndex) unique key.
// 3. Normalizes social links and resolves the avatar CID to a Pinata
//    gateway URL.
// 4. Appends the raw event to `SocialMetadataEvent` (stored per creator key).
// 5. Upserts the `CreatorSocialMetadata` read model, unless the event is
//    older (ledger / socialUpdatedAt) than the already-synced state.
// 6. Invalidates creator caches synchronously so API responses reflect the
//    update within the 60-second freshness budget (immediately in practice).
//
// Cursor advancement is handled by the pipeline dispatcher
// (`processIndexerEvents` in indexer-pipeline.service.ts), not by this
// service, so a batch containing multiple event types advances the cursor
// exactly once.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import {
   normalizeIpfsCid,
   resolvePinataGatewayUrl,
} from '../../utils/pinata-gateway.utils';
import { normalizeSocialLinkUrl } from '../creator/creator-social-link-url.utils';
import { invalidateCreatorSocialMetadataCache } from '../creators/creator-social-cache-invalidation';

/** Discriminator for social metadata extension contract events. */
export const SOCIAL_METADATA_UPDATED_EVENT_TYPE = 'SOCIAL_METADATA_UPDATED';

/** A single social link carried by a SocialMetadataUpdated event. */
export interface SocialMetadataLink {
   label: string;
   url: string;
}

/**
 * Typed shape of a decoded SocialMetadataUpdated event delivered by the
 * external indexing worker. All profile fields are optional — the contract
 * emits whatever changed, and absent fields are preserved on sync.
 */
export interface SocialMetadataUpdatedEvent extends IndexerChainEvent {
   creatorId: string;
   actor?: string;
   displayName?: string | null;
   bio?: string | null;
   avatarCid?: string | null;
   avatarUrl?: string | null;
   socialLinks?: SocialMetadataLink[] | null;
   /** ISO timestamp (or epoch ms) of the off-chain metadata update. */
   socialUpdatedAt?: string | number | null;
}

function isSocialMetadataUpdatedEvent(
   event: IndexerChainEvent
): event is SocialMetadataUpdatedEvent {
   return event.eventType === SOCIAL_METADATA_UPDATED_EVENT_TYPE;
}

function parseEventDate(
   value: string | number | null | undefined
): Date | null {
   if (value === undefined || value === null || value === '') {
      return null;
   }

   const date =
      typeof value === 'number' ? new Date(value) : new Date(String(value));
   return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeSocialLinks(
   links: SocialMetadataLink[] | null | undefined
): SocialMetadataLink[] | null {
   if (!Array.isArray(links) || links.length === 0) {
      return null;
   }

   const normalized: SocialMetadataLink[] = [];
   for (const link of links) {
      if (
         !link ||
         typeof link.label !== 'string' ||
         typeof link.url !== 'string'
      ) {
         continue;
      }

      const label = link.label.trim();
      const url = link.url.trim();
      if (!label || !url) {
         continue;
      }

      normalized.push({ label, url: normalizeSocialLinkUrl(url) });
   }

   return normalized.length > 0 ? normalized : null;
}

/**
 * Determines whether an incoming event is older than the currently synced
 * snapshot. Stale events still get recorded in `SocialMetadataEvent`, but
 * they must not roll the read model backwards when events arrive out of
 * order.
 */
function isStaleRelativeToSnapshot(
   snapshot: { sourceLedger: number | null; socialUpdatedAt: Date | null },
   incomingLedger: number | null,
   incomingSocialUpdatedAt: Date | null
): boolean {
   if (
      incomingSocialUpdatedAt &&
      snapshot.socialUpdatedAt &&
      incomingSocialUpdatedAt.getTime() < snapshot.socialUpdatedAt.getTime()
   ) {
      return true;
   }

   if (
      incomingLedger !== null &&
      snapshot.sourceLedger !== null &&
      incomingLedger < snapshot.sourceLedger
   ) {
      return true;
   }

   return false;
}

/**
 * Processes a single SocialMetadataUpdated event.
 *
 * Idempotent: replaying the same (txHash, eventIndex) is a no-op apart from
 * a debug log. Returns `false` when the event was skipped (missing
 * `creatorId` or already indexed), `true` when it was processed.
 */
export async function processSocialMetadataUpdatedEvent(
   event: SocialMetadataUpdatedEvent
): Promise<boolean> {
   const eventId = `${event.txHash}:${event.eventIndex}`;

   if (!event.creatorId) {
      logger.warn(
         { eventId, missingField: 'creatorId' },
         'Skipping social metadata event due to missing required field'
      );
      return false;
   }

   const { creatorId } = event;
   const txHash = String(event.txHash);
   const eventIndex = Number(event.eventIndex);
   const incomingLedger =
      typeof event.ledger === 'number' ? event.ledger : null;
   const socialUpdatedAt = parseEventDate(event.socialUpdatedAt);

   // Duplicate guard — same (txHash, eventIndex) already indexed.
   const existingEvent = await prisma.socialMetadataEvent.findUnique({
      where: { txHash_eventIndex: { txHash, eventIndex } },
      select: { id: true },
   });

   if (existingEvent) {
      logger.debug(
         {
            type: 'social_metadata_event_duplicate_skipped',
            eventId,
            creator_id: creatorId,
         },
         'Social metadata event already indexed; skipping'
      );
      return false;
   }

   const avatarCid = normalizeIpfsCid(event.avatarCid);
   const avatarUrl =
      resolvePinataGatewayUrl(event.avatarCid) ??
      (typeof event.avatarUrl === 'string' && event.avatarUrl.trim()
         ? event.avatarUrl.trim()
         : null);
   const socialLinks = normalizeSocialLinks(event.socialLinks);

   // Store the raw event per key (append-only history).
   try {
      await prisma.socialMetadataEvent.create({
         data: {
            creatorId,
            txHash,
            eventIndex,
            ledger: incomingLedger,
            actor: event.actor ?? null,
            displayName: event.displayName ?? null,
            bio: event.bio ?? null,
            avatarCid,
            avatarUrl,
            socialLinks: socialLinks as any,
            rawPayload: {
               eventType: event.eventType,
               creatorId,
               actor: event.actor ?? null,
               displayName: event.displayName ?? null,
               bio: event.bio ?? null,
               avatarCid: event.avatarCid ?? null,
               avatarUrl: event.avatarUrl ?? null,
               socialLinks: event.socialLinks ?? null,
               socialUpdatedAt: event.socialUpdatedAt ?? null,
               ledger: incomingLedger,
            } as any,
            socialUpdatedAt,
         },
      });
   } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'P2002') {
         logger.debug(
            {
               type: 'social_metadata_event_duplicate_skipped',
               eventId,
               creator_id: creatorId,
            },
            'Social metadata event already indexed (unique constraint); skipping'
         );
         return false;
      }
      throw error;
   }

   // Sync the per-creator read model unless this event is stale.
   const snapshot = await prisma.creatorSocialMetadata.findUnique({
      where: { creatorId },
      select: {
         sourceLedger: true,
         socialUpdatedAt: true,
         sourceTxHash: true,
      },
   });

   if (
      snapshot &&
      isStaleRelativeToSnapshot(snapshot, incomingLedger, socialUpdatedAt)
   ) {
      logger.debug(
         {
            type: 'social_metadata_snapshot_stale_skipped',
            eventId,
            creator_id: creatorId,
            incoming_ledger: incomingLedger,
            synced_ledger: snapshot.sourceLedger,
         },
         'Social metadata event is older than synced snapshot; not overwriting'
      );
   } else {
      // Only overwrite fields the event actually carries so partial update
      // events do not wipe earlier-synced values.
      const update: Record<string, unknown> = {};
      if (event.displayName !== undefined) {
         update.displayName = event.displayName ?? null;
      }
      if (event.bio !== undefined) {
         update.bio = event.bio ?? null;
      }
      if (event.avatarCid !== undefined) {
         update.avatarCid = avatarCid;
      }
      if (event.avatarUrl !== undefined || event.avatarCid !== undefined) {
         update.avatarUrl = avatarUrl;
      }
      if (event.socialLinks !== undefined) {
         update.socialLinks = socialLinks as any;
      }
      update.sourceLedger = incomingLedger;
      update.sourceTxHash = txHash;
      update.sourceEventIndex = eventIndex;
      if (socialUpdatedAt) {
         update.socialUpdatedAt = socialUpdatedAt;
      }

      await prisma.creatorSocialMetadata.upsert({
         where: { creatorId },
         create: {
            creatorId,
            displayName: event.displayName ?? null,
            bio: event.bio ?? null,
            avatarCid,
            avatarUrl,
            socialLinks: socialLinks as any,
            sourceLedger: incomingLedger,
            sourceTxHash: txHash,
            sourceEventIndex: eventIndex,
            socialUpdatedAt,
         },
         update,
      });

      logger.info(
         {
            type: 'social_metadata_synced',
            eventId,
            creator_id: creatorId,
            ledger: incomingLedger,
            avatar_resolved: avatarUrl ?? null,
         },
         'Creator social metadata synced'
      );
   }

   // Invalidate caches synchronously so API reads never serve the previous
   // social state (freshness budget: 60 seconds; met immediately here).
   invalidateCreatorSocialMetadataCache({
      creatorId,
      txHash,
      eventIndex,
   });

   return true;
}

/**
 * Processes a batch of SocialMetadataUpdated events.
 *
 * Deduplicates via the shared indexer engine, dispatches each unique event
 * to {@link processSocialMetadataUpdatedEvent}, and ignores other event
 * types. Does not advance the ledger cursor — the pipeline dispatcher
 * (`processIndexerEvents`) does that once per batch.
 */
export async function processSocialMetadataEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!isSocialMetadataUpdatedEvent(event)) {
         return;
      }

      await processSocialMetadataUpdatedEvent(event);
   });
}
