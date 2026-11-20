// src/modules/creators/creator-social.service.ts
//
// Read side of the creator social metadata sync.
//
// Data is written by the indexer on each SocialMetadataUpdated event
// (see modules/indexer/social-metadata-indexer.service.ts) and served by:
// - GET /api/v1/creators/:wallet/social
// - the `social` block of creator detail / profile responses

import { prisma } from '../../utils/prisma.utils';
import { formatIsoTimestamp } from '../../utils/iso-timestamp.utils';
import {
   CreatorSocialData,
   CreatorSocialLink,
   CreatorSocialResponse,
} from './creator-social.schemas';

/**
 * Shape of a synced `CreatorSocialMetadata` read-model row.
 */
export interface CreatorSocialSnapshot {
   displayName: string | null;
   bio: string | null;
   avatarCid: string | null;
   avatarUrl: string | null;
   socialLinks: unknown;
   sourceLedger: number | null;
   sourceTxHash: string | null;
   sourceEventIndex: number | null;
   socialUpdatedAt: Date | null;
}

const CREATOR_SOCIAL_SNAPSHOT_SELECT = {
   displayName: true,
   bio: true,
   avatarCid: true,
   avatarUrl: true,
   socialLinks: true,
   sourceLedger: true,
   sourceTxHash: true,
   sourceEventIndex: true,
   socialUpdatedAt: true,
} as const;

/**
 * Reads the synced social metadata snapshot for a creator.
 *
 * @returns The snapshot row, or null when no SocialMetadataUpdated event has
 *          been synced for the creator yet.
 */
export async function getCreatorSocialSnapshot(
   creatorId: string
): Promise<CreatorSocialSnapshot | null> {
   return prisma.creatorSocialMetadata.findUnique({
      where: { creatorId },
      select: CREATOR_SOCIAL_SNAPSHOT_SELECT,
   });
}

/**
 * Resolves a creator by wallet address (primary), falling back to creator
 * id or handle so the social endpoint stays usable during early adoption
 * (before wallets are linked) and in internal tooling.
 */
export async function findCreatorForSocial(
   walletOrCreatorId: string
): Promise<{ id: string; handle: string; userId: string } | null> {
   return prisma.creatorProfile.findFirst({
      where: {
         OR: [
            { user: { stellarWallet: { address: walletOrCreatorId } } },
            { id: walletOrCreatorId },
            { handle: walletOrCreatorId },
         ],
      },
      select: { id: true, handle: true, userId: true },
   });
}

function coerceSocialLinks(value: unknown): CreatorSocialLink[] {
   if (!Array.isArray(value)) {
      return [];
   }

   const links: CreatorSocialLink[] = [];
   for (const item of value) {
      if (
         item &&
         typeof item === 'object' &&
         typeof (item as any).label === 'string' &&
         typeof (item as any).url === 'string'
      ) {
         links.push({
            label: (item as any).label,
            url: (item as any).url,
         });
      }
   }

   return links;
}

/**
 * Builds the social data block served inside creator detail/profile
 * responses. Returns null when nothing has been synced yet so callers can
 * distinguish "never synced" from "synced with empty values".
 */
export function buildCreatorSocialData(
   snapshot: CreatorSocialSnapshot | null
): CreatorSocialData | null {
   if (!snapshot) {
      return null;
   }

   return {
      displayName: snapshot.displayName,
      bio: snapshot.bio,
      avatarUrl: snapshot.avatarUrl,
      avatarCid: snapshot.avatarCid,
      links: coerceSocialLinks(snapshot.socialLinks),
      synced: true,
      updatedAt: snapshot.socialUpdatedAt
         ? formatIsoTimestamp(snapshot.socialUpdatedAt)
         : null,
      source: {
         ledger: snapshot.sourceLedger,
         txHash: snapshot.sourceTxHash,
         eventIndex: snapshot.sourceEventIndex,
      },
   };
}

/**
 * Reads the social metadata for a creator, resolved by wallet address with
 * a creator id / handle fallback.
 *
 * @returns The full social response, or null when no creator matches.
 */
export async function getCreatorSocial(
   walletOrCreatorId: string
): Promise<CreatorSocialResponse | null> {
   const trimmed = walletOrCreatorId.trim();
   if (!trimmed) {
      return null;
   }

   const creator = await findCreatorForSocial(trimmed);
   if (!creator) {
      return null;
   }

   const [snapshot, wallet] = await Promise.all([
      getCreatorSocialSnapshot(creator.id),
      prisma.stellarWallet.findFirst({
         where: { userId: creator.userId },
         select: { address: true },
      }),
   ]);

   const social = buildCreatorSocialData(snapshot) ?? {
      displayName: null,
      bio: null,
      avatarUrl: null,
      avatarCid: null,
      links: [],
      synced: false,
      updatedAt: null,
      source: null,
   };

   return {
      creatorId: creator.id,
      handle: creator.handle,
      wallet: wallet?.address ?? null,
      ...social,
   };
}
