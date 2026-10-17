// src/modules/creator/creator-social-metadata-sync.service.test.ts
jest.mock('chalk', () => ({
   red: (text: string) => text,
   green: (text: string) => text,
   magenta: (text: string) => text,
   cyan: (text: string) => text,
}));

jest.mock('tspec', () => ({
   TspecDocsMiddleware: jest.fn().mockResolvedValue([]),
}));

const mockFindFirstCreator = jest.fn();
const mockUpdateCreator = jest.fn();
const mockCountKeyOwnership = jest.fn();
const mockFindManyTrade = jest.fn();

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: (...args: unknown[]) => mockFindFirstCreator(...args),
         update: (...args: unknown[]) => mockUpdateCreator(...args),
      },
      keyOwnership: {
         count: (...args: unknown[]) => mockCountKeyOwnership(...args),
      },
      trade: {
         findMany: (...args: unknown[]) => mockFindManyTrade(...args),
      },
      factoryDeployedKey: {
         findUnique: jest.fn().mockResolvedValue(null),
      },
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      isLevelEnabled: jest.fn().mockReturnValue(false),
   },
}));

jest.mock('../../config', () => ({
   envConfig: {
      MODE: 'test',
      PORT: 3000,
      ENABLE_REQUEST_LOGGING: false,
      PINATA_GATEWAY_URL: 'https://gateway.pinata.cloud/ipfs',
   },
   appConfig: { allowedOrigins: [] },
}));

const mockCacheGetJson = jest.fn();
const mockCacheSetJson = jest.fn();
const mockCacheInvalidate = jest.fn();

jest.mock('../../utils/redis.utils', () => ({
   getRedis: jest.fn(() => null),
   getRedisClient: jest.fn(() => null),
   cacheGetJson: (...args: unknown[]) => mockCacheGetJson(...args),
   cacheSetJson: (...args: unknown[]) => mockCacheSetJson(...args),
   cacheInvalidate: (...args: unknown[]) => mockCacheInvalidate(...args),
   buildCacheKey: (...parts: string[]) => parts.join(':'),
}));

const mockResetCreatorListCache = jest.fn();
jest.mock('../creators/creators.cache', () => ({
   resetCreatorListCache: () => mockResetCreatorListCache(),
}));

import supertest from 'supertest';
import app from '../../app';
import { Keypair } from '@stellar/stellar-base';
import {
   CreatorSocialProfileNotFoundError,
   getCreatorSocialMetadata,
   processSocialMetadataUpdatedEvents,
   syncCreatorSocialMetadata,
} from './creator-social-metadata-sync.service';

describe('Creator Social Metadata Sync Service & API (#1037)', () => {
   const walletAddress = Keypair.random().publicKey();
   const creatorId = 'creator-social-1037';
   const handle = 'socialcreator1037';

   let storedProfile: any;

   beforeEach(() => {
      jest.clearAllMocks();

      storedProfile = {
         id: creatorId,
         userId: 'user-1037',
         handle,
         displayName: 'Initial Creator',
         bio: 'Initial bio',
         avatarCid: 'bafybeinitialcid111',
         avatarUrl: 'https://gateway.pinata.cloud/ipfs/bafybeinitialcid111',
         twitter: 'https://twitter.com/initial',
         website: 'https://initial.example.com',
         discord: 'https://discord.gg/initial',
         isVerified: true,
         followersCount: 15,
         tradingPaused: false,
         currentMilestone: 1,
         relaunchCount: 0,
         createdAt: new Date('2026-10-01T00:00:00.000Z'),
         updatedAt: new Date('2026-10-16T00:00:00.000Z'),
         priceSnapshot: null,
         perks: [],
         user: {
            id: 'user-1037',
            stellarWallet: {
               address: walletAddress,
            },
         },
      };

      mockCacheGetJson.mockResolvedValue(null);
      mockCacheSetJson.mockResolvedValue(true);
      mockCacheInvalidate.mockResolvedValue(1);
      mockCountKeyOwnership.mockResolvedValue(5);
      mockFindManyTrade.mockResolvedValue([]);

      mockFindFirstCreator.mockImplementation(async ({ where }: any) => {
         const matches =
            where?.id === creatorId ||
            where?.handle === handle ||
            where?.OR?.some?.(
               (cond: any) =>
                  cond.id === creatorId ||
                  cond.id === walletAddress ||
                  cond.handle === creatorId ||
                  cond.handle === handle ||
                  cond.handle === walletAddress ||
                  cond.user?.stellarWallet?.address === walletAddress
            );
         return matches ? storedProfile : null;
      });

      mockUpdateCreator.mockImplementation(async ({ data }: any) => {
         storedProfile = {
            ...storedProfile,
            ...data,
            updatedAt: new Date('2026-10-17T00:00:00.000Z'),
         };
         return storedProfile;
      });
   });

   describe('processSocialMetadataUpdatedEvents & syncCreatorSocialMetadata', () => {
      it('indexes SocialMetadataUpdated event, resolves avatar CID to Pinata URL, and invalidates caches', async () => {
         await processSocialMetadataUpdatedEvents([
            {
               eventType: 'SocialMetadataUpdated',
               txHash: 'tx-social-1037',
               eventIndex: 0,
               ledger: 7777,
               keyId: creatorId,
               displayName: 'Synced Stella Key',
               bio: 'Updated bio from contract event',
               avatarCid: 'ipfs://QmSyncedAvatarCid999',
               twitter: 'https://Twitter.com/StellaSynced?utm_source=test',
               website: 'https://stella.example.org/key',
               discord: 'https://discord.gg/stella',
            },
         ]);

         expect(mockUpdateCreator).toHaveBeenCalledWith({
            where: { id: creatorId },
            data: expect.objectContaining({
               displayName: 'Synced Stella Key',
               bio: 'Updated bio from contract event',
               avatarCid: 'ipfs://QmSyncedAvatarCid999',
               avatarUrl:
                  'https://gateway.pinata.cloud/ipfs/QmSyncedAvatarCid999',
               twitter: 'https://twitter.com/StellaSynced',
               website: 'https://stella.example.org/key',
               discord: 'https://discord.gg/stella',
            }),
         });

         expect(mockCacheInvalidate).toHaveBeenCalledWith(
            expect.stringContaining(`creator:social:${creatorId}`),
            expect.stringContaining(`creator:social:${handle}`),
            expect.stringContaining(`creator:social:${walletAddress}`),
            expect.stringContaining(`creator:profile:${creatorId}`),
            expect.stringContaining(`creator:profile:${handle}`),
            expect.stringContaining(`creator:profile:${walletAddress}`),
            expect.stringContaining(`key-metadata:${creatorId}`),
            'creators:*',
            'creator:*'
         );
         expect(mockResetCreatorListCache).toHaveBeenCalled();
      });

      it('throws CreatorSocialProfileNotFoundError when syncing unknown creator', async () => {
         await expect(
            syncCreatorSocialMetadata('unknown-wallet', {
               displayName: 'No One',
            })
         ).rejects.toBeInstanceOf(CreatorSocialProfileNotFoundError);
      });
   });

   describe('GET /api/v1/creators/:wallet/social & profile/key detail responses', () => {
      it('returns synced display name, bio, resolved avatar URL, and social links on GET /creators/:wallet/social', async () => {
         await syncCreatorSocialMetadata(walletAddress, {
            displayName: 'Post Sync Creator',
            bio: 'Post sync bio',
            avatar_cid: 'bafybeipostsynccid777',
            twitter: 'https://twitter.com/postsync',
            website: 'https://postsync.io',
            discord: 'https://discord.gg/postsync',
         });

         const res = await supertest(app).get(
            `/api/v1/creators/${walletAddress}/social`
         );

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toMatchObject({
            creatorId,
            keyId: creatorId,
            handle,
            wallet: walletAddress,
            displayName: 'Post Sync Creator',
            bio: 'Post sync bio',
            avatarCid: 'bafybeipostsynccid777',
            avatarUrl:
               'https://gateway.pinata.cloud/ipfs/bafybeipostsynccid777',
            twitter: 'https://twitter.com/postsync',
            website: 'https://postsync.io/',
            discord: 'https://discord.gg/postsync',
            socialLinks: {
               twitter: 'https://twitter.com/postsync',
               website: 'https://postsync.io/',
               discord: 'https://discord.gg/postsync',
            },
         });
      });

      it('includes synced social data in creator profile and key detail API responses', async () => {
         await syncCreatorSocialMetadata(creatorId, {
            displayName: 'Unified Key Creator',
            bio: 'Unified bio across endpoints',
            avatarCid: 'QmUnifiedCid123',
            twitter: 'https://twitter.com/unified',
            website: 'https://unified.dev',
            discord: 'https://discord.gg/unified',
         });

         // 1. Creator public profile endpoint (/api/v1/creators/:id)
         const profileRes = await supertest(app).get(
            `/api/v1/creators/${creatorId}`
         );
         expect(profileRes.status).toBe(200);
         expect(profileRes.body.data).toMatchObject({
            id: creatorId,
            displayName: 'Unified Key Creator',
            bio: 'Unified bio across endpoints',
            avatarUrl: 'https://gateway.pinata.cloud/ipfs/QmUnifiedCid123',
            socialLinks: {
               twitter: 'https://twitter.com/unified',
               website: 'https://unified.dev/',
               discord: 'https://discord.gg/unified',
            },
         });

         // 2. Key detail endpoint (/api/v1/keys/:keyId)
         const keyRes = await supertest(app).get(`/api/v1/keys/${creatorId}`);
         expect(keyRes.status).toBe(200);
         expect(keyRes.body.data).toMatchObject({
            creatorId,
            displayName: 'Unified Key Creator',
            bio: 'Unified bio across endpoints',
            avatarUrl: 'https://gateway.pinata.cloud/ipfs/QmUnifiedCid123',
            socialLinks: {
               twitter: 'https://twitter.com/unified',
               website: 'https://unified.dev/',
               discord: 'https://discord.gg/unified',
            },
         });
      });

      it('returns 404 when social profile does not exist', async () => {
         const unknownWallet = Keypair.random().publicKey();
         const res = await supertest(app).get(
            `/api/v1/creators/${unknownWallet}/social`
         );

         expect(res.status).toBe(404);
         expect(res.body.success).toBe(false);
      });

      it('serves cached social metadata within 60s TTL when cache is warm', async () => {
         mockCacheGetJson.mockResolvedValueOnce({
            creatorId,
            keyId: creatorId,
            handle,
            wallet: walletAddress,
            displayName: 'Cached Creator',
            bio: 'Cached bio',
            avatarCid: 'QmCached',
            avatarUrl: 'https://gateway.pinata.cloud/ipfs/QmCached',
            twitter: null,
            website: null,
            discord: null,
            socialLinks: { twitter: null, website: null, discord: null },
            links: [],
            updatedAt: '2026-10-17T00:00:00.000Z',
         });

         const result = await getCreatorSocialMetadata(walletAddress);
         expect(result.displayName).toBe('Cached Creator');
         expect(mockFindFirstCreator).not.toHaveBeenCalled();
      });
   });
});
