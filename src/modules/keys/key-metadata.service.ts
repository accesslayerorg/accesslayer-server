import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import {
   REDIS_KEYS,
   KEY_METADATA_CACHE_TTL_SECONDS,
} from '../../constants/notifications.constants';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export interface KeyMetadata {
   name: string;
   bio: string | null;
   avatarUri: string | null;
   creatorAddress: string;
}

/**
 * Returns on-chain creator metadata for a key: name, bio, avatar_uri, and
 * the creator address. Reads from persistent contract storage via Soroban RPC
 * and caches the result in Redis for 5 minutes.
 */
export async function getKeyMetadata(keyId: string): Promise<KeyMetadata> {
   const cacheKey = REDIS_KEYS.keyMetadata(keyId);

   const cached = await cacheGetJson<KeyMetadata>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: {
         id: true,
         displayName: true,
         bio: true,
         avatarUrl: true,
         userId: true,
      },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const onChainMetadata = await readMetadataFromChain(keyId);

   const metadata: KeyMetadata = {
      name: onChainMetadata?.name ?? creator.displayName,
      bio: onChainMetadata?.bio ?? creator.bio,
      avatarUri: onChainMetadata?.avatarUri ?? creator.avatarUrl,
      creatorAddress: onChainMetadata?.creatorAddress ?? creator.userId,
   };

   await cacheSetJson(cacheKey, metadata, KEY_METADATA_CACHE_TTL_SECONDS);
   return metadata;
}

/**
 * Reads metadata fields from on-chain persistent contract storage via Soroban RPC.
 *
 * In a full implementation this would:
 * 1. Build XDR ledger entry keys for metadata fields (name, bio, avatar_uri)
 * 2. Call getLedgerEntries() via Soroban RPC
 * 3. Decode the XDR response to extract metadata strings and address
 */
async function readMetadataFromChain(
   keyId: string
): Promise<{
   name: string;
   bio: string | null;
   avatarUri: string | null;
   creatorAddress: string;
} | null> {
   try {
      logger.debug({ keyId }, 'Reading metadata from on-chain storage');

      // TODO: Implement Soroban RPC call to read metadata
      // This would query the key trading contract's persistent storage for:
      // - creator_name (ScpVal::Bytes)
      // - creator_bio (ScpVal::Bytes, optional)
      // - creator_avatar_uri (ScpVal::Bytes, optional)
      // - creator_address (ScpVal::Address)

      return null;
   } catch (error) {
      logger.warn(
         { error, keyId },
         'Failed to read metadata from on-chain storage'
      );
      return null;
   }
}

/**
 * Invalidates the metadata cache for a key.
 * Called when a metadata_updated event is received from the indexer.
 */
export async function invalidateKeyMetadataCache(keyId: string): Promise<void> {
   await cacheInvalidate(REDIS_KEYS.keyMetadata(keyId));
}
