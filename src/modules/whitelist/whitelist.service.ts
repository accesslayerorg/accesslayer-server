import {
   Account,
   Address,
   Contract,
   Networks,
   TransactionBuilder,
   xdr,
} from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';

/**
 * Whitelist status response for a creator key.
 */
export interface WhitelistStatus {
   is_whitelisted: boolean;
   whitelist_mode_enabled: boolean;
   // Aliases for backward compatibility
   whitelistEnabled: boolean;
   isApproved: boolean;
}

export interface BulkWhitelistStatusItem {
   wallet: string;
   is_whitelisted: boolean;
   whitelist_mode_enabled: boolean;
   whitelistEnabled: boolean;
   isApproved: boolean;
}

export interface BulkWhitelistStatusResult {
   whitelist_mode_enabled: boolean;
   results: BulkWhitelistStatusItem[];
   wallets: BulkWhitelistStatusItem[];
   total: number;
}

/**
 * Cache TTL for whitelist status: 30 seconds
 */
export const WHITELIST_CACHE_TTL_SECONDS = 30;

/**
 * Builds a cache key for whitelist status lookup.
 * Format: `whitelist:{creatorId}:{walletAddress}`
 */
export function buildWhitelistCacheKey(
   creatorId: string,
   walletAddress: string
): string {
   return `whitelist:${creatorId}:${walletAddress}`;
}

export type OnChainWhitelistFetcher = (
   contractIdOrKeyId: string,
   wallet: string
) => Promise<{ is_whitelisted: boolean; whitelist_mode_enabled: boolean } | null>;

let customFetcher: OnChainWhitelistFetcher | null = null;

/**
 * Configures an optional custom on-chain whitelist fetcher (for testing or RPC injection).
 */
export function setOnChainWhitelistFetcher(
   fetcher: OnChainWhitelistFetcher | null
): void {
   customFetcher = fetcher;
}

function networkPassphrase(): string {
   return envConfig.STELLAR_NETWORK === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET;
}

/**
 * Builds an unsigned simulated transaction envelope to query `get_whitelist_status(wallet)`.
 */
export function buildWhitelistStatusViewXdr(
   contractId: string,
   wallet: string,
   sequence = '0'
): string {
   const dummySource = wallet.startsWith('G')
      ? wallet
      : 'GBTEST0000000000000000000000000000000000000000000000000000';
   const operation = new Contract(contractId).call(
      'get_whitelist_status',
      new Address(wallet).toScVal()
   );
   return new TransactionBuilder(new Account(dummySource, sequence), {
      fee: '100',
      networkPassphrase: networkPassphrase(),
   })
      .addOperation(operation)
      .setTimeout(300)
      .build()
      .toXDR();
}

/**
 * Decodes the return value of get_whitelist_status into flags.
 */
export function decodeWhitelistStatusScVal(
   scValXdr: string
): { is_whitelisted: boolean; whitelist_mode_enabled: boolean } | null {
   try {
      const val = xdr.ScVal.fromXDR(scValXdr, 'base64');
      const type = val.switch();

      if (type === xdr.ScValType.scvBool()) {
         const whitelisted = val.b();
         return {
            is_whitelisted: whitelisted,
            whitelist_mode_enabled: true,
         };
      }

      if (type === xdr.ScValType.scvVec()) {
         const vec = val.vec() ?? [];
         if (vec.length >= 2) {
            const first =
               vec[0].switch() === xdr.ScValType.scvBool() ? vec[0].b() : false;
            const second =
               vec[1].switch() === xdr.ScValType.scvBool() ? vec[1].b() : false;
            return {
               is_whitelisted: first,
               whitelist_mode_enabled: second,
            };
         } else if (
            vec.length === 1 &&
            vec[0].switch() === xdr.ScValType.scvBool()
         ) {
            return {
               is_whitelisted: vec[0].b(),
               whitelist_mode_enabled: true,
            };
         }
      }

      if (type === xdr.ScValType.scvMap()) {
         const map = val.map() ?? [];
         let is_whitelisted = false;
         let whitelist_mode_enabled = false;
         for (const entry of map) {
            const keyType = entry.key().switch();
            let keyName = '';
            if (keyType === xdr.ScValType.scvSymbol()) {
               keyName = entry.key().sym().toString().toLowerCase();
            } else if (keyType === xdr.ScValType.scvString()) {
               keyName = entry.key().str().toString().toLowerCase();
            }

            const valType = entry.val().switch();
            const boolVal =
               valType === xdr.ScValType.scvBool() ? entry.val().b() : false;

            if (
               keyName === 'is_whitelisted' ||
               keyName === 'isapproved' ||
               keyName === 'whitelisted' ||
               keyName === 'approved'
            ) {
               is_whitelisted = boolVal;
            } else if (
               keyName === 'whitelist_mode_enabled' ||
               keyName === 'whitelistenabled' ||
               keyName === 'mode_enabled' ||
               keyName === 'enabled'
            ) {
               whitelist_mode_enabled = boolVal;
            }
         }
         return { is_whitelisted, whitelist_mode_enabled };
      }

      return null;
   } catch (error) {
      logger.debug(
         { error: (error as Error).message },
         'Failed to decode whitelist status ScVal'
      );
      return null;
   }
}

/**
 * Fetches whitelist status from the contract via Soroban RPC.
 */
export async function fetchOnChainWhitelistStatus(
   contractId: string,
   wallet: string
): Promise<{ is_whitelisted: boolean; whitelist_mode_enabled: boolean } | null> {
   if (customFetcher) {
      const custom = await customFetcher(contractId, wallet);
      if (custom !== null) return custom;
   }

   if (!envConfig.STELLAR_SOROBAN_RPC_URL) {
      return null;
   }

   const controller = new AbortController();
   const timeout = setTimeout(
      () => controller.abort(),
      envConfig.DB_QUERY_TIMEOUT_MS
   );

   try {
      const transactionXdr = buildWhitelistStatusViewXdr(contractId, wallet);
      const response = await fetch(envConfig.STELLAR_SOROBAN_RPC_URL, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'get-whitelist-status',
            method: 'simulateTransaction',
            params: { transaction: transactionXdr },
         }),
         signal: controller.signal,
      });

      if (!response.ok) {
         logger.warn(
            { status: response.status, contractId, wallet },
            'Soroban RPC returned non-200 while querying whitelist status'
         );
         return null;
      }

      const envelope = (await response.json()) as {
         error?: { message?: string };
         result?: { results?: Array<{ xdr?: string; retval?: string }> };
      };

      if (envelope.error) {
         logger.warn(
            { error: envelope.error, contractId, wallet },
            'Soroban RPC error while simulating get_whitelist_status'
         );
         return null;
      }

      const returnedXdr =
         envelope.result?.results?.[0]?.retval ??
         envelope.result?.results?.[0]?.xdr;

      if (!returnedXdr) {
         return null;
      }

      return decodeWhitelistStatusScVal(returnedXdr);
   } catch (error) {
      logger.warn(
         { error, contractId, wallet },
         'Error calling get_whitelist_status on-chain'
      );
      return null;
   } finally {
      clearTimeout(timeout);
   }
}

async function resolveContractIdForKey(creatorId: string): Promise<string | null> {
   if (creatorId.startsWith('C') && creatorId.length >= 50) {
      return creatorId;
   }
   const regKey = await prisma.registeredKey.findFirst({
      where: {
         OR: [{ id: creatorId }, { keyAddress: creatorId }, { handle: creatorId }],
      },
      select: { keyAddress: true },
   });
   return regKey?.keyAddress ?? null;
}

/**
 * Retrieves the whitelist status for a creator key and wallet address.
 * Returns is_whitelisted and whitelist_mode_enabled status with 30s Redis caching.
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
         return {
            is_whitelisted: cached.is_whitelisted ?? cached.isApproved ?? false,
            whitelist_mode_enabled:
               cached.whitelist_mode_enabled ?? cached.whitelistEnabled ?? false,
            isApproved: cached.is_whitelisted ?? cached.isApproved ?? false,
            whitelistEnabled:
               cached.whitelist_mode_enabled ?? cached.whitelistEnabled ?? false,
         };
      }
   } catch (error) {
      logger.warn(
         { error, cacheKey },
         'Error reading from whitelist cache'
      );
   }

   // Compute fresh whitelist status
   const status = await computeWhitelistStatus(creatorId, walletAddress);

   // Cache the result
   try {
      await cacheSetJson(cacheKey, status, WHITELIST_CACHE_TTL_SECONDS);
   } catch (error) {
      logger.warn(
         { error, cacheKey },
         'Error writing to whitelist cache'
      );
   }

   return status;
}

/**
 * Computes whitelist status from on-chain contract or indexed database state.
 */
async function computeWhitelistStatus(
   creatorId: string,
   walletAddress: string
): Promise<WhitelistStatus> {
   try {
      if (customFetcher) {
         const custom = await customFetcher(creatorId, walletAddress);
         if (custom !== null) {
            return {
               is_whitelisted: custom.is_whitelisted,
               whitelist_mode_enabled: custom.whitelist_mode_enabled,
               isApproved: custom.is_whitelisted,
               whitelistEnabled: custom.whitelist_mode_enabled,
            };
         }
      }

      // Try on-chain contract call if key has associated contract
      const contractId = await resolveContractIdForKey(creatorId);
      if (contractId) {
         const onChain = await fetchOnChainWhitelistStatus(
            contractId,
            walletAddress
         );
         if (onChain !== null) {
            return {
               is_whitelisted: onChain.is_whitelisted,
               whitelist_mode_enabled: onChain.whitelist_mode_enabled,
               isApproved: onChain.is_whitelisted,
               whitelistEnabled: onChain.whitelist_mode_enabled,
            };
         }
      }

      // Fallback: Check local synced database state
      const count = await prisma.whitelist.count({
         where: { creatorId },
      });

      const whitelist_mode_enabled = count > 0;
      let is_whitelisted = false;

      if (whitelist_mode_enabled) {
         const entry = await prisma.whitelist.findUnique({
            where: {
               address_creatorId: {
                  address: walletAddress,
                  creatorId,
               },
            },
         });
         is_whitelisted = !!entry;
      }

      return {
         is_whitelisted,
         whitelist_mode_enabled,
         isApproved: is_whitelisted,
         whitelistEnabled: whitelist_mode_enabled,
      };
   } catch (error) {
      logger.error(
         { error, creatorId, walletAddress },
         'Error computing whitelist status'
      );
      return {
         is_whitelisted: false,
         whitelist_mode_enabled: false,
         isApproved: false,
         whitelistEnabled: false,
      };
   }
}

/**
 * Bulk checks whitelist status for multiple wallets under a key.
 */
export async function getBulkWhitelistStatus(
   creatorId: string,
   wallets: string[]
): Promise<BulkWhitelistStatusResult> {
   const statuses = await Promise.all(
      wallets.map(async wallet => {
         const status = await getWhitelistStatus(creatorId, wallet);
         return {
            wallet,
            is_whitelisted: status.is_whitelisted,
            whitelist_mode_enabled: status.whitelist_mode_enabled,
            isApproved: status.isApproved,
            whitelistEnabled: status.whitelistEnabled,
         };
      })
   );

   const whitelist_mode_enabled = statuses.some(s => s.whitelist_mode_enabled);

   return {
      whitelist_mode_enabled,
      results: statuses,
      wallets: statuses,
      total: statuses.length,
   };
}

/**
 * Invalidates cached whitelist status for a key and optional specific wallet.
 */
export async function invalidateWhitelistCache(
   creatorId: string,
   walletAddress?: string
): Promise<void> {
   try {
      if (walletAddress) {
         await cacheInvalidate(buildWhitelistCacheKey(creatorId, walletAddress));
      } else {
         await cacheInvalidate(`whitelist:${creatorId}:*`);
      }
   } catch (error) {
      logger.warn(
         { error, creatorId, walletAddress },
         'Error invalidating whitelist cache'
      );
   }
}

/**
 * Resolves a :key_id or :keyId path param to the creator profile id.
 */
export async function resolveCreatorId(keyId: string): Promise<string | null> {
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true },
   });
   if (creator?.id) return creator.id;

   const regKey = await prisma.registeredKey.findFirst({
      where: {
         OR: [{ id: keyId }, { keyAddress: keyId }, { handle: keyId }],
      },
      select: { id: true },
   });
   return regKey?.id ?? null;
}

export interface AddWalletsResult {
   added: string[];
   alreadyWhitelisted: string[];
}

/**
 * Adds wallets to a creator's whitelist. Idempotent: wallets that are
 * already present are reported in `alreadyWhitelisted` rather than failing.
 */
export async function addWalletsToWhitelist(
   creatorId: string,
   wallets: string[]
): Promise<AddWalletsResult> {
   const existing = await prisma.whitelist.findMany({
      where: { creatorId, address: { in: wallets } },
      select: { address: true },
   });
   const existingSet = new Set(existing.map(e => e.address));
   const added = wallets.filter(w => !existingSet.has(w));

   if (added.length > 0) {
      await prisma.whitelist.createMany({
         data: added.map(address => ({ address, creatorId })),
         skipDuplicates: true,
      });
      for (const w of added) {
         await invalidateWhitelistCache(creatorId, w);
      }
      await invalidateWhitelistCache(creatorId);
   }

   return {
      added,
      alreadyWhitelisted: wallets.filter(w => existingSet.has(w)),
   };
}

/**
 * Removes a wallet from a creator's whitelist.
 */
export async function removeWalletFromWhitelist(
   creatorId: string,
   wallet: string
): Promise<boolean> {
   const { count } = await prisma.whitelist.deleteMany({
      where: { creatorId, address: wallet },
   });
   if (count > 0) {
      await invalidateWhitelistCache(creatorId, wallet);
      await invalidateWhitelistCache(creatorId);
   }
   return count > 0;
}

/**
 * Returns the whitelist synced into the database for a creator key,
 * oldest entry first.
 */
export async function listWhitelist(
   creatorId: string
): Promise<Array<{ address: string; addedAt: Date }>> {
   const entries = await prisma.whitelist.findMany({
      where: { creatorId },
      select: { address: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { address: 'asc' }],
   });
   return entries.map(e => ({ address: e.address, addedAt: e.createdAt }));
}

/**
 * Verifies that a creator or key exists.
 */
export async function creatorExists(creatorId: string): Promise<boolean> {
   try {
      const creator = await prisma.creatorProfile.findFirst({
         where: { OR: [{ id: creatorId }, { handle: creatorId }] },
         select: { id: true },
      });
      if (creator) return true;

      const regKey = await prisma.registeredKey.findFirst({
         where: {
            OR: [{ id: creatorId }, { keyAddress: creatorId }, { handle: creatorId }],
         },
         select: { id: true },
      });
      return !!regKey;
   } catch (error) {
      logger.error(
         { error, creatorId },
         'Error checking creator existence'
      );
      return false;
   }
}
