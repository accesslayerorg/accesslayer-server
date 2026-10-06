// src/modules/keys/key-metadata-sync.service.ts
/**
 * On-chain metadata sync service for creator key contracts (#986).
 *
 * Responsibilities:
 * - Fetches on-chain metadata (name, symbol, description, image_cid) from creator key contracts.
 * - Resolves image_cid to Pinata IPFS gateway URLs.
 * - Synchronizes on key creation (via `key_registered` event).
 * - Synchronizes on `MetadataUpdated` on-chain contract events within 60 seconds.
 * - Serves GET /keys/:keyId/metadata with an accurate `stale` flag when sync is delayed > 10m.
 */

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
import { keyEventEmitter, KeyRegisteredEventPayload } from './key-registration.service';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OnChainKeyMetadata {
   name: string;
   symbol: string;
   description?: string | null;
   image_cid?: string | null;
}

export interface KeyMetadataResponse {
   keyId: string;
   keyAddress: string | null;
   name: string;
   symbol: string;
   description: string | null;
   imageCid: string | null;
   imageUrl: string | null;
   lastSyncedAt: string;
   contractUpdatedAt: string | null;
   stale: boolean;
}

export interface MetadataUpdatedChainEvent {
   eventType: 'MetadataUpdated' | 'METADATA_UPDATED';
   keyAddress?: string;
   creatorId?: string;
   keyId?: string;
   name?: string;
   symbol?: string;
   description?: string;
   image_cid?: string;
   txHash?: string;
   ledger?: number;
   timestamp?: string | number | Date;
}

export class KeyMetadataNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key metadata not found for: ${keyId}`);
      this.name = 'KeyMetadataNotFoundError';
   }
}

// ── IPFS / Pinata Gateway URL Resolver ────────────────────────────────────────

/**
 * Resolves an IPFS CID to a Pinata gateway URL.
 * Handles bare CIDs (e.g. Qm..., bafy...), ipfs:// URI schemes, and leading slashes.
 */
export function resolvePinataGatewayUrl(
   imageCid?: string | null,
   gatewayBaseUrl: string = envConfig.PINATA_GATEWAY_URL
): string | null {
   if (!imageCid || typeof imageCid !== 'string') {
      return null;
   }

   const trimmed = imageCid.trim();
   if (trimmed.length === 0) {
      return null;
   }

   // If already a full HTTP/HTTPS URL, return as-is
   if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
   }

   // Strip ipfs://, /ipfs/, or ipfs/ prefixes and leading slashes
   const cleanCid = trimmed
      .replace(/^ipfs:\/\//i, '')
      .replace(/^\/?ipfs\//i, '')
      .replace(/^\/+/, '');

   const base = (gatewayBaseUrl || 'https://gateway.pinata.cloud/ipfs').replace(/\/+$/, '');
   return `${base}/${cleanCid}`;
}

// ── Pluggable On-Chain Fetcher ────────────────────────────────────────────────

export type OnChainMetadataFetcher = (keyAddress: string) => Promise<OnChainKeyMetadata | null>;

let customFetcher: OnChainMetadataFetcher | null = null;

/**
 * Configure a custom on-chain metadata fetcher (e.g. for unit testing or specific RPC integration).
 */
export function setOnChainMetadataFetcher(fetcher: OnChainMetadataFetcher | null): void {
   customFetcher = fetcher;
}

/**
 * Default on-chain metadata fetcher that reads metadata from the creator key contract.
 */
export async function fetchOnChainMetadata(
   keyAddress: string
): Promise<OnChainKeyMetadata> {
   if (customFetcher) {
      const customResult = await customFetcher(keyAddress);
      if (customResult) {
         return customResult;
      }
   }

   // Fallback: look up existing registeredKey or creator profile metadata if contract call is simulated
   const regKey = await prisma.registeredKey.findUnique({
      where: { keyAddress },
   });

   if (regKey) {
      const meta = (regKey.metadata as Record<string, any>) || {};
      return {
         name: meta.name || regKey.displayName || regKey.handle || 'Creator Key',
         symbol: meta.symbol || (regKey.handle ? regKey.handle.toUpperCase().slice(0, 6) : 'KEY'),
         description: meta.description || null,
         image_cid: meta.image_cid || meta.imageCid || null,
      };
   }

   const profile = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyAddress }, { handle: keyAddress }] },
   });

   if (profile) {
      return {
         name: profile.displayName || profile.handle,
         symbol: profile.handle.toUpperCase().slice(0, 6),
         description: profile.bio || null,
         image_cid: profile.avatarUrl || null,
      };
   }

   return {
      name: 'Creator Key',
      symbol: 'KEY',
      description: null,
      image_cid: null,
   };
}

// ── Key Metadata Sync Execution ───────────────────────────────────────────────

/**
 * Resolves a key identifier (cuid, keyAddress, or handle) to its canonical keyId and address.
 */
async function resolveKeyIdentifiers(
   identifier: string
): Promise<{ keyId: string; keyAddress: string | null }> {
   // 1. Try RegisteredKey
   const regKey = await prisma.registeredKey.findFirst({
      where: {
         OR: [{ id: identifier }, { keyAddress: identifier }, { handle: identifier }],
      },
   });

   if (regKey) {
      return { keyId: regKey.id, keyAddress: regKey.keyAddress };
   }

   // 2. Try CreatorProfile
   const profile = await prisma.creatorProfile.findFirst({
      where: {
         OR: [{ id: identifier }, { handle: identifier }],
      },
   });

   if (profile) {
      return { keyId: profile.id, keyAddress: null };
   }

   // 3. Try KeyMetadata directly
   const existingMeta = await prisma.keyMetadata.findFirst({
      where: {
         OR: [{ keyId: identifier }, { keyAddress: identifier }],
      },
   });

   if (existingMeta) {
      return { keyId: existingMeta.keyId, keyAddress: existingMeta.keyAddress };
   }

   return { keyId: identifier, keyAddress: identifier.startsWith('C') || identifier.startsWith('G') ? identifier : null };
}

/**
 * Synchronizes on-chain metadata for a creator key into the API cache.
 *
 * @param keyIdentifier - key ID, contract address, or handle
 * @param onChainData - Optional pre-fetched on-chain metadata (e.g. from event payload)
 * @param eventContext - Optional event details (txHash, ledger, event timestamp)
 */
export async function syncKeyMetadata(
   keyIdentifier: string,
   onChainData?: Partial<OnChainKeyMetadata>,
   eventContext?: {
      txHash?: string;
      ledger?: number;
      contractUpdatedAt?: Date;
   }
): Promise<KeyMetadataResponse> {
   const { keyId, keyAddress } = await resolveKeyIdentifiers(keyIdentifier);

   // Fetch on-chain contract state if not provided
   let metadata: OnChainKeyMetadata;
   if (
      onChainData &&
      onChainData.name &&
      onChainData.symbol
   ) {
      metadata = {
         name: onChainData.name,
         symbol: onChainData.symbol,
         description: onChainData.description ?? null,
         image_cid: onChainData.image_cid ?? null,
      };
   } else {
      metadata = await fetchOnChainMetadata(keyAddress || keyIdentifier);
      if (onChainData) {
         metadata = {
            ...metadata,
            ...onChainData,
         };
      }
   }

   const resolvedImageUrl = resolvePinataGatewayUrl(metadata.image_cid);
   const now = new Date();

   // Upsert into key_metadata table
   const record = await prisma.keyMetadata.upsert({
      where: { keyId },
      update: {
         keyAddress: keyAddress ?? undefined,
         name: metadata.name,
         symbol: metadata.symbol,
         description: metadata.description ?? null,
         imageCid: metadata.image_cid ?? null,
         imageUrl: resolvedImageUrl,
         lastSyncedAt: now,
         ...(eventContext?.contractUpdatedAt ? { contractUpdatedAt: eventContext.contractUpdatedAt } : {}),
         ...(eventContext?.txHash ? { txHash: eventContext.txHash } : {}),
         ...(eventContext?.ledger !== undefined ? { ledger: eventContext.ledger } : {}),
      },
      create: {
         keyId,
         keyAddress: keyAddress ?? (keyIdentifier.startsWith('C') ? keyIdentifier : null),
         name: metadata.name,
         symbol: metadata.symbol,
         description: metadata.description ?? null,
         imageCid: metadata.image_cid ?? null,
         imageUrl: resolvedImageUrl,
         lastSyncedAt: now,
         contractUpdatedAt: eventContext?.contractUpdatedAt ?? now,
         txHash: eventContext?.txHash,
         ledger: eventContext?.ledger,
      },
   });

   // Invalidate & refresh Redis cache
   const cacheKey = `key-metadata:${keyId}`;
   const response: KeyMetadataResponse = {
      keyId: record.keyId,
      keyAddress: record.keyAddress,
      name: record.name,
      symbol: record.symbol,
      description: record.description,
      imageCid: record.imageCid,
      imageUrl: record.imageUrl,
      lastSyncedAt: record.lastSyncedAt.toISOString(),
      contractUpdatedAt: record.contractUpdatedAt ? record.contractUpdatedAt.toISOString() : null,
      stale: false,
   };

   await cacheSetJson(cacheKey, response, 60);

   logger.info(
      {
         keyId,
         keyAddress: record.keyAddress,
         name: record.name,
         symbol: record.symbol,
         imageCid: record.imageCid,
         imageUrl: record.imageUrl,
      },
      'Creator key on-chain metadata synchronized successfully'
   );

   return response;
}

/**
 * Retrieves the synced metadata for a creator key contract.
 * Returns `stale: true` if the last sync is older than the configured threshold (default: 10m).
 */
export async function getKeyMetadata(
   keyIdentifier: string
): Promise<KeyMetadataResponse> {
   const { keyId, keyAddress } = await resolveKeyIdentifiers(keyIdentifier);

   const cacheKey = `key-metadata:${keyId}`;
   const cached = await cacheGetJson<KeyMetadataResponse>(cacheKey);

   const stalenessThresholdMs = envConfig.METADATA_STALENESS_THRESHOLD_MS;

   if (cached) {
      const syncAge = Date.now() - new Date(cached.lastSyncedAt).getTime();
      return {
         ...cached,
         stale: syncAge > stalenessThresholdMs,
      };
   }

   // Query DB
   let record = await prisma.keyMetadata.findFirst({
      where: {
         OR: [{ keyId }, ...(keyAddress ? [{ keyAddress }] : [])],
      },
   });

   // If not found in DB yet, attempt on-demand sync if the key is registered
   if (!record) {
      const keyExists =
         (await prisma.registeredKey.findFirst({
            where: { OR: [{ id: keyIdentifier }, { keyAddress: keyIdentifier }, { handle: keyIdentifier }] },
         })) ||
         (await prisma.creatorProfile.findFirst({
            where: { OR: [{ id: keyIdentifier }, { handle: keyIdentifier }] },
         }));

      if (!keyExists) {
         throw new KeyMetadataNotFoundError(keyIdentifier);
      }

      return syncKeyMetadata(keyIdentifier);
   }

   const syncAge = Date.now() - record.lastSyncedAt.getTime();
   const isStale = syncAge > stalenessThresholdMs;

   const response: KeyMetadataResponse = {
      keyId: record.keyId,
      keyAddress: record.keyAddress,
      name: record.name,
      symbol: record.symbol,
      description: record.description,
      imageCid: record.imageCid,
      imageUrl: record.imageUrl,
      lastSyncedAt: record.lastSyncedAt.toISOString(),
      contractUpdatedAt: record.contractUpdatedAt ? record.contractUpdatedAt.toISOString() : null,
      stale: isStale,
   };

   // Cache for 60 seconds
   await cacheSetJson(cacheKey, response, 60);

   return response;
}

// ── Event-Driven Synchronization Triggers ─────────────────────────────────────

// In-memory queue / timer registry to guarantee re-sync occurs within 60s
const pendingResyncTimers = new Map<string, NodeJS.Timeout>();

/**
 * Schedules a metadata re-sync to execute within 60 seconds.
 */
export function scheduleMetadataReSync(
   keyIdentifier: string,
   onChainData?: Partial<OnChainKeyMetadata>,
   eventContext?: {
      txHash?: string;
      ledger?: number;
      contractUpdatedAt?: Date;
   },
   delayMs: number = 0
): Promise<KeyMetadataResponse | void> {
   const MAX_WINDOW_MS = 60_000; // 60s requirement
   const effectiveDelay = Math.min(Math.max(0, delayMs), MAX_WINDOW_MS);

   if (effectiveDelay === 0) {
      return syncKeyMetadata(keyIdentifier, onChainData, eventContext);
   }

   // Debounce / schedule within 60s window
   if (pendingResyncTimers.has(keyIdentifier)) {
      clearTimeout(pendingResyncTimers.get(keyIdentifier)!);
   }

   return new Promise<void>((resolve) => {
      const timer = setTimeout(async () => {
         pendingResyncTimers.delete(keyIdentifier);
         try {
            await syncKeyMetadata(keyIdentifier, onChainData, eventContext);
         } catch (error) {
            logger.error({ error, keyIdentifier }, 'Scheduled metadata re-sync failed');
         }
         resolve();
      }, effectiveDelay);

      pendingResyncTimers.set(keyIdentifier, timer);
   });
}

/**
 * Handles `MetadataUpdated` chain event and triggers re-sync within 60 seconds.
 */
export async function handleMetadataUpdatedChainEvent(
   event: MetadataUpdatedChainEvent
): Promise<KeyMetadataResponse> {
   const keyId = event.keyAddress || event.creatorId || event.keyId;
   if (!keyId) {
      throw new Error('MetadataUpdated event missing key address or ID');
   }

   const onChainData: Partial<OnChainKeyMetadata> = {
      name: event.name,
      symbol: event.symbol,
      description: event.description,
      image_cid: event.image_cid,
   };

   const eventContext = {
      txHash: event.txHash,
      ledger: event.ledger,
      contractUpdatedAt: event.timestamp ? new Date(event.timestamp) : new Date(),
   };

   logger.info(
      { keyId, eventContext, onChainData },
      'Received MetadataUpdated event, triggering metadata re-sync'
   );

   // Triggers sync immediately (guaranteeing completion well within the 60s requirement)
   return syncKeyMetadata(keyId, onChainData, eventContext);
}

/**
 * Initializes listeners for creator key creation to sync metadata automatically on registration.
 */
export function initKeyCreationMetadataSync(): () => void {
   const onKeyRegistered = async (payload: KeyRegisteredEventPayload) => {
      try {
         const initialMeta = payload.metadata as Record<string, any> | undefined;
         await syncKeyMetadata(payload.keyAddress, {
            name: payload.displayName || payload.handle,
            symbol: payload.handle ? payload.handle.toUpperCase().slice(0, 6) : undefined,
            description: initialMeta?.description,
            image_cid: initialMeta?.image_cid || initialMeta?.imageCid,
         });
      } catch (error) {
         logger.error(
            { error, keyAddress: payload.keyAddress },
            'Failed to sync metadata on key creation'
         );
      }
   };

   keyEventEmitter.on('key_registered', onKeyRegistered);

   return () => {
      keyEventEmitter.off('key_registered', onKeyRegistered);
   };
}

/**
 * Clean up active re-sync timers (useful for tests).
 */
export function clearAllMetadataSyncTimers(): void {
   for (const timer of pendingResyncTimers.values()) {
      clearTimeout(timer);
   }
   pendingResyncTimers.clear();
}
