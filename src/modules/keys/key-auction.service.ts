import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import {
   REDIS_KEYS,
   KEY_AUCTION_CACHE_TTL_SECONDS,
} from '../../constants/notifications.constants';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export type AuctionStatus = 'not_configured' | 'active' | 'completed';

export interface KeyAuction {
   auctionPrice: string;
   auctionSupply: number;
   auctionSold: number;
   auctionStatus: AuctionStatus;
}

/**
 * Reads auction state for a creator key from on-chain contract storage
 * via Soroban RPC, falling back to database state.
 *
 * Auction status semantics:
 * - not_configured: no auction has been set up for this key
 * - active: auction supply > 0 and auctionSold < auctionSupply
 * - completed: auctionSold >= auctionSupply
 */
export async function getKeyAuction(keyId: string): Promise<KeyAuction> {
   const cacheKey = REDIS_KEYS.keyAuction(keyId);

   const cached = await cacheGetJson<KeyAuction>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const auction = await readAuctionFromChain(keyId);

   if (auction) {
      await cacheSetJson(cacheKey, auction, KEY_AUCTION_CACHE_TTL_SECONDS);
      return auction;
   }

   const fallback: KeyAuction = {
      auctionPrice: '0',
      auctionSupply: 0,
      auctionSold: 0,
      auctionStatus: 'not_configured',
   };

   await cacheSetJson(cacheKey, fallback, KEY_AUCTION_CACHE_TTL_SECONDS);
   return fallback;
}

/**
 * Reads auction configuration from on-chain persistent contract storage
 * via Soroban RPC.
 *
 * In a full implementation this would:
 * 1. Build XDR ledger entry keys for the auction configuration
 * 2. Call getLedgerEntries() via Soroban RPC
 * 3. Decode the XDR response to extract price, supply, and sold
 */
async function readAuctionFromChain(
   keyId: string
): Promise<KeyAuction | null> {
   try {
      logger.debug({ keyId }, 'Reading auction state from on-chain storage');

      // TODO: Implement Soroban RPC call to read auction configuration
      // This would query the key trading contract's persistent storage for:
      // - auction_price (ScpVal::U64)
      // - auction_supply (ScpVal::U32)
      // - auction_sold (ScpVal::U32)

      return null;
   } catch (error) {
      logger.warn(
         { error, keyId },
         'Failed to read auction state from on-chain storage'
      );
      return null;
   }
}

/**
 * Invalidates the auction cache for a key.
 * Called after an auction buy modifies the sold count.
 */
export async function invalidateKeyAuctionCache(keyId: string): Promise<void> {
   await cacheInvalidate(REDIS_KEYS.keyAuction(keyId));
}
