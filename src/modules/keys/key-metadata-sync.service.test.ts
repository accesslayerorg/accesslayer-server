// src/modules/keys/key-metadata-sync.service.test.ts
const cacheStore = new Map<string, unknown>();
const memoryDb = {
   keyMetadata: new Map<string, any>(),
   registeredKey: new Map<string, any>(),
   creatorProfile: new Map<string, any>(),
};

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) =>
      cacheStore.has(key) ? (cacheStore.get(key) as unknown) : null
   ),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => {
      cacheStore.set(key, value);
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyMetadata: {
         upsert: jest.fn(async ({ where, create, update }) => {
            const key = where.keyId;
            const existing = memoryDb.keyMetadata.get(key);
            const data = existing ? { ...existing, ...update, updatedAt: new Date() } : { ...create, id: 'meta-' + key, createdAt: new Date(), updatedAt: new Date() };
            memoryDb.keyMetadata.set(key, data);
            return data;
         }),
         findFirst: jest.fn(async ({ where }) => {
            if (where.OR) {
               for (const cond of where.OR) {
                  if (cond.keyId && memoryDb.keyMetadata.has(cond.keyId)) {
                     return memoryDb.keyMetadata.get(cond.keyId);
                  }
                  if (cond.keyAddress) {
                     for (const row of memoryDb.keyMetadata.values()) {
                        if (row.keyAddress === cond.keyAddress) return row;
                     }
                  }
               }
            }
            if (where.keyId) return memoryDb.keyMetadata.get(where.keyId) || null;
            return null;
         }),
         findUnique: jest.fn(async ({ where }) => {
            return memoryDb.keyMetadata.get(where.keyId) || null;
         }),
      },
      registeredKey: {
         findUnique: jest.fn(async ({ where }) => {
            if (where.keyAddress) {
               for (const row of memoryDb.registeredKey.values()) {
                  if (row.keyAddress === where.keyAddress) return row;
               }
            }
            return memoryDb.registeredKey.get(where.id) || null;
         }),
         findFirst: jest.fn(async ({ where }) => {
            if (where.OR) {
               for (const cond of where.OR) {
                  if (cond.id && memoryDb.registeredKey.has(cond.id)) return memoryDb.registeredKey.get(cond.id);
                  if (cond.keyAddress) {
                     for (const row of memoryDb.registeredKey.values()) {
                        if (row.keyAddress === cond.keyAddress) return row;
                     }
                  }
                  if (cond.handle) {
                     for (const row of memoryDb.registeredKey.values()) {
                        if (row.handle === cond.handle) return row;
                     }
                  }
               }
            }
            return null;
         }),
      },
      creatorProfile: {
         findFirst: jest.fn(async ({ where }) => {
            if (where.OR) {
               for (const cond of where.OR) {
                  if (cond.id && memoryDb.creatorProfile.has(cond.id)) return memoryDb.creatorProfile.get(cond.id);
                  if (cond.handle) {
                     for (const row of memoryDb.creatorProfile.values()) {
                        if (row.handle === cond.handle) return row;
                     }
                  }
               }
            }
            return null;
         }),
      },
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import {
   resolvePinataGatewayUrl,
   syncKeyMetadata,
   getKeyMetadata,
   handleMetadataUpdatedChainEvent,
   initKeyCreationMetadataSync,
   setOnChainMetadataFetcher,
   KeyMetadataNotFoundError,
   clearAllMetadataSyncTimers,
} from './key-metadata-sync.service';
import { prisma } from '../../utils/prisma.utils';
import { emitKeyRegisteredEvent } from './key-registration.service';

describe('Key Metadata Sync Service', () => {
   const MOCK_KEY_ADDRESS = 'CCW67TSB3SSS33333333333333333333333333333333333333333333';
   const MOCK_CREATOR_WALLET = 'GA5XIGA5C7GTGTW7ZKJ4YV6OEILUY2Q7YIHZQNNDJUWAVES4O7D5SUK7';
   const MOCK_CID = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';

   beforeEach(() => {
      jest.clearAllMocks();
      cacheStore.clear();
      memoryDb.keyMetadata.clear();
      memoryDb.registeredKey.clear();
      memoryDb.creatorProfile.clear();
      clearAllMetadataSyncTimers();
      setOnChainMetadataFetcher(null);
   });

   afterEach(() => {
      clearAllMetadataSyncTimers();
      setOnChainMetadataFetcher(null);
   });

   describe('resolvePinataGatewayUrl', () => {
      it('resolves raw CID to default Pinata gateway URL', () => {
         const url = resolvePinataGatewayUrl(MOCK_CID);
         expect(url).toBe(`https://gateway.pinata.cloud/ipfs/${MOCK_CID}`);
      });

      it('strips ipfs:// prefix correctly', () => {
         const url = resolvePinataGatewayUrl(`ipfs://${MOCK_CID}`);
         expect(url).toBe(`https://gateway.pinata.cloud/ipfs/${MOCK_CID}`);
      });

      it('strips /ipfs/ prefix and leading slashes', () => {
         const url = resolvePinataGatewayUrl(`/ipfs/${MOCK_CID}`);
         expect(url).toBe(`https://gateway.pinata.cloud/ipfs/${MOCK_CID}`);
      });

      it('preserves existing https:// URLs', () => {
         const directUrl = 'https://custom-gateway.io/ipfs/my-hash';
         expect(resolvePinataGatewayUrl(directUrl)).toBe(directUrl);
      });

      it('returns null for empty or non-string inputs', () => {
         expect(resolvePinataGatewayUrl(null)).toBeNull();
         expect(resolvePinataGatewayUrl(undefined)).toBeNull();
         expect(resolvePinataGatewayUrl('')).toBeNull();
         expect(resolvePinataGatewayUrl('   ')).toBeNull();
      });

      it('supports custom gateway base URL', () => {
         const custom = 'https://my-subdomain.mypinata.cloud/ipfs';
         const url = resolvePinataGatewayUrl(MOCK_CID, custom);
         expect(url).toBe(`https://my-subdomain.mypinata.cloud/ipfs/${MOCK_CID}`);
      });
   });

   describe('syncKeyMetadata', () => {
      it('fetches on-chain metadata, resolves Pinata gateway URL, and stores in database', async () => {
         setOnChainMetadataFetcher(async (addr) => {
            expect(addr).toBe(MOCK_KEY_ADDRESS);
            return {
               name: 'StarForge Key',
               symbol: 'SFK',
               description: 'Exclusive creator access key',
               image_cid: MOCK_CID,
            };
         });

         const synced = await syncKeyMetadata(MOCK_KEY_ADDRESS);

         expect(synced.name).toBe('StarForge Key');
         expect(synced.symbol).toBe('SFK');
         expect(synced.description).toBe('Exclusive creator access key');
         expect(synced.imageCid).toBe(MOCK_CID);
         expect(synced.imageUrl).toBe(`https://gateway.pinata.cloud/ipfs/${MOCK_CID}`);
         expect(synced.stale).toBe(false);
         expect(new Date(synced.lastSyncedAt).getTime()).toBeLessThanOrEqual(Date.now());

         // Verify stored in DB
         const stored = await prisma.keyMetadata.findFirst({
            where: { keyId: synced.keyId },
         });
         expect(stored).not.toBeNull();
         expect(stored?.name).toBe('StarForge Key');
         expect(stored?.imageUrl).toBe(`https://gateway.pinata.cloud/ipfs/${MOCK_CID}`);
      });
   });

   describe('getKeyMetadata and staleness', () => {
      it('returns correct metadata values and stale=false when sync is recent', async () => {
         await prisma.keyMetadata.upsert({
            where: { keyId: 'key-recent-1' },
            create: {
               keyId: 'key-recent-1',
               keyAddress: MOCK_KEY_ADDRESS,
               name: 'Fresh Key',
               symbol: 'FRSH',
               description: 'Recently synced',
               imageCid: MOCK_CID,
               imageUrl: `https://gateway.pinata.cloud/ipfs/${MOCK_CID}`,
               lastSyncedAt: new Date(Date.now() - 60_000), // 1 minute ago
            },
            update: {
               lastSyncedAt: new Date(Date.now() - 60_000),
            },
         });

         const meta = await getKeyMetadata('key-recent-1');
         expect(meta.name).toBe('Fresh Key');
         expect(meta.symbol).toBe('FRSH');
         expect(meta.stale).toBe(false);
      });

      it('sets stale=true when sync job is behind by more than 10 minutes', async () => {
         const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);

         await prisma.keyMetadata.upsert({
            where: { keyId: 'key-stale-1' },
            create: {
               keyId: 'key-stale-1',
               name: 'Delayed Key',
               symbol: 'DELAY',
               description: 'Sync is delayed',
               imageCid: MOCK_CID,
               imageUrl: `https://gateway.pinata.cloud/ipfs/${MOCK_CID}`,
               lastSyncedAt: elevenMinutesAgo,
            },
            update: {
               lastSyncedAt: elevenMinutesAgo,
            },
         });

         const meta = await getKeyMetadata('key-stale-1');
         expect(meta.name).toBe('Delayed Key');
         expect(meta.stale).toBe(true);
      });

      it('throws KeyMetadataNotFoundError when key does not exist', async () => {
         await expect(getKeyMetadata('non-existent-key-9999')).rejects.toThrow(
            KeyMetadataNotFoundError
         );
      });
   });

   describe('MetadataUpdated event handling', () => {
      it('re-syncs metadata and stores updated values from MetadataUpdated event within 60s', async () => {
         const eventTimestamp = new Date();
         const updated = await handleMetadataUpdatedChainEvent({
            eventType: 'MetadataUpdated',
            keyAddress: MOCK_KEY_ADDRESS,
            name: 'Updated Key Title',
            symbol: 'UPDT',
            description: 'New description from event',
            image_cid: 'QmUpdatedHash123',
            txHash: '0x1234abcd',
            ledger: 10450,
            timestamp: eventTimestamp,
         });

         expect(updated.name).toBe('Updated Key Title');
         expect(updated.symbol).toBe('UPDT');
         expect(updated.description).toBe('New description from event');
         expect(updated.imageCid).toBe('QmUpdatedHash123');
         expect(updated.imageUrl).toBe('https://gateway.pinata.cloud/ipfs/QmUpdatedHash123');
         expect(updated.stale).toBe(false);

         // Verify database has updated values
         const record = await prisma.keyMetadata.findUnique({
            where: { keyId: updated.keyId },
         });
         expect(record?.name).toBe('Updated Key Title');
         expect(record?.symbol).toBe('UPDT');
         expect(record?.txHash).toBe('0x1234abcd');
         expect(record?.ledger).toBe(10450);
      });
   });

   describe('Key creation metadata sync integration', () => {
      it('syncs metadata automatically when a key is registered', async () => {
         const cleanupListener = initKeyCreationMetadataSync();

         const testAddress = 'CCWTESTCREATIONADDRESS3333333333333333333333333333333333';
         setOnChainMetadataFetcher(async () => ({
            name: 'Brand New Key',
            symbol: 'BNK',
            description: 'Created on-chain',
            image_cid: MOCK_CID,
         }));

         await emitKeyRegisteredEvent({
            keyAddress: testAddress,
            creatorWallet: MOCK_CREATOR_WALLET,
            handle: 'newcreator',
            displayName: 'Brand New Key',
            metadata: {
               image_cid: MOCK_CID,
            },
         });

         // Wait a brief moment for async event listener to settle
         await new Promise((resolve) => setTimeout(resolve, 50));

         const meta = await getKeyMetadata(testAddress);
         expect(meta.name).toBe('Brand New Key');
         expect(meta.imageUrl).toBe(`https://gateway.pinata.cloud/ipfs/${MOCK_CID}`);
         expect(meta.stale).toBe(false);

         cleanupListener();
      });
   });
});
