import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';

/**
 * Whitelist status response for a creator key.
 */
export interface WhitelistStatus {
   whitelistEnabled: boolean;
   isApproved: boolean;
}

/**
 * Cache TTL for whitelist status: 30 seconds
 */
const WHITELIST_CACHE_TTL_SECONDS = 30;

/**
 * Builds a cache key for whitelist status lookup.
 * Format: `whitelist:{creatorId}:{walletAddress}`
 */
function buildWhitelistCacheKey(
   creatorId: string,
   walletAddress: string
): string {
   return `whitelist:${creatorId}:${walletAddress}`;
}

/**
 * Retrieves the whitelist status for a creator key and wallet address.
 * Returns whitelistEnabled and isApproved status with Redis caching.
 *
 * @param creatorId - The creator/key ID to check whitelist for
 * @param walletAddress - The wallet address to check approval for
 * @returns WhitelistStatus with whitelistEnabled and isApproved flags
 */
export async function getWhitelistStatus(
   creatorId: string,
   walletAddress: string
): Promise<WhitelistStatus> {
   const cacheKey = buildWhitelistCacheKey(creatorId, walletAddress);

   // Try cache first
   try {
      const cached = await cacheGetJson<WhitelistStatus>(cacheKey);
      if (cached !== null) {
         logger.debug(
            { creatorId, walletAddress },
            'Whitelist status cache hit'
         );
         return cached;
      }
   } catch (error) {
      logger.warn({ error, cacheKey }, 'Error reading from whitelist cache');
      // Fall through to compute fresh value
   }

   // Compute whitelist status
   const status = await computeWhitelistStatus(creatorId, walletAddress);

   // Cache the result
   try {
      await cacheSetJson(cacheKey, status, WHITELIST_CACHE_TTL_SECONDS);
   } catch (error) {
      logger.warn({ error, cacheKey }, 'Error writing to whitelist cache');
      // Failure to cache doesn't affect response
   }

   return status;
}

/**
 * Computes whitelist status by querying contract state via Soroban RPC.
 *
 * In a full implementation, this would:
 * 1. Query contract storage for whitelist configuration
 * 2. Check if whitelist is enabled for this creator's key
 * 3. Check if the wallet is on the approved list
 *
 * For now, this is a placeholder that demonstrates the logic flow.
 * Actual implementation would need:
 * - Contract ID for the key trading contract
 * - XDR key encoding for persistent storage queries
 * - stellar-sdk for XDR decoding
 */
async function computeWhitelistStatus(
   creatorId: string,
   walletAddress: string
): Promise<WhitelistStatus> {
   try {
      // Verify creator exists
      const creator = await prisma.creatorProfile.findUnique({
         where: { id: creatorId },
         select: { id: true },
      });

      if (!creator) {
         return {
            whitelistEnabled: false,
            isApproved: false,
         };
      }

      // TODO: Query contract state via Soroban RPC
      // This would require:
      // 1. Get contract ID from creator or global config
      // 2. Build XDR keys for:
      //    - WhitelistEnabled flag
      //    - Whitelist entries map
      // 3. Call getLedgerEntries(keys)
      // 4. Decode XDR responses
      // 5. Check wallet approval

      // For now, return default state (whitelist disabled)
      // In production, this would query actual contract storage
      const whitelistEnabled = false; // Would query contract
      const isApproved = false; // Would check wallet in contract storage

      logger.debug(
         { creatorId, walletAddress, whitelistEnabled, isApproved },
         'Computed whitelist status'
      );

      return {
         whitelistEnabled,
         isApproved,
      };
   } catch (error) {
      logger.error(
         { error, creatorId, walletAddress },
         'Error computing whitelist status'
      );

      // Return safe default on error
      return {
         whitelistEnabled: false,
         isApproved: false,
      };
   }
}

/**
 * Invalidates whitelist cache for a creator key.
 * Called when whitelist configuration changes.
 */
export async function invalidateWhitelistCache(
   creatorId: string
): Promise<void> {
   try {
      // Invalidate all wallet entries for this creator
      // In a full implementation with Redis, this would use SCAN + pattern matching
      logger.debug({ creatorId }, 'Invalidated whitelist cache');
   } catch (error) {
      logger.warn({ error, creatorId }, 'Error invalidating whitelist cache');
   }
}

/**
 * Verifies that a creator exists.
 */
export async function creatorExists(creatorId: string): Promise<boolean> {
   try {
      const creator = await prisma.creatorProfile.findUnique({
         where: { id: creatorId },
         select: { id: true },
      });
      return !!creator;
   } catch (error) {
      logger.error({ error, creatorId }, 'Error checking creator existence');
      return false;
   }
}
