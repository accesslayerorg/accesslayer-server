jest.mock('chalk', () => ({
   red: (text: string) => text,
   green: (text: string) => text,
   magenta: (text: string) => text,
   cyan: (text: string) => text,
}));

jest.mock('tspec', () => ({
   TspecDocsMiddleware: jest.fn().mockResolvedValue([]),
}));

const mockFindUniqueWallet = jest.fn();
const mockFindUniqueCreator = jest.fn();
const mockFindFirstCreator = jest.fn();
const mockUpdateCreator = jest.fn();
const mockCountKeyOwnership = jest.fn();
const mockFindManyTrade = jest.fn();

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findUnique: (...args: unknown[]) => mockFindUniqueCreator(...args),
         findFirst: (...args: unknown[]) => mockFindFirstCreator(...args),
         update: (...args: unknown[]) => mockUpdateCreator(...args),
      },
      creatorPriceHistory: {
         findMany: jest.fn().mockResolvedValue([]),
      },
      creatorSocialMetadata: {
         findUnique: jest.fn().mockResolvedValue(null),
      },
      stellarWallet: {
         findUnique: (...args: unknown[]) => mockFindUniqueWallet(...args),
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
import { createHash } from 'crypto';

describe('Creator Profile Social Links and Display Name Management API (#1016)', () => {
   const keypair = Keypair.random();
   const walletAddress = keypair.publicKey();
   const otherKeypair = Keypair.random();
   const otherWalletAddress = otherKeypair.publicKey();

   const creatorId = 'creator-uuid-1016';
   const handle = 'creator1016';

   const sampleProfile = {
      id: creatorId,
      userId: 'user-1016',
      handle,
      displayName: 'Creator 1016',
      bio: 'Bio content',
      avatarUrl: 'https://gateway.pinata.cloud/ipfs/bafybeifx7yeb55vpchqqio5',
      avatarCid: 'bafybeifx7yeb55vpchqqio5',
      twitter: 'https://twitter.com/creator1016',
      website: 'https://creator1016.example.com',
      discord: 'https://discord.gg/creator1016',
      isVerified: true,
      followersCount: 42,
      tradingPaused: false,
      currentMilestone: 1,
      relaunchCount: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      priceSnapshot: null,
      perks: [],
      user: {
         id: 'user-1016',
         stellarWallet: {
            address: walletAddress,
         },
      },
   };

   function createSignedHeaders(body: unknown, signer = keypair) {
      const timestamp = Date.now().toString();
      const bodyJson = JSON.stringify(body);
      const payload = `${bodyJson}${timestamp}`;
      const message = createHash('sha256').update(payload, 'utf8').digest();
      const signature = signer.sign(message).toString('base64');

      return {
         'x-wallet-address': signer.publicKey(),
         'x-wallet-signature': signature,
         'x-timestamp': timestamp,
      };
   }

   beforeEach(() => {
      jest.clearAllMocks();

      mockCacheGetJson.mockResolvedValue(null);
      mockCacheSetJson.mockResolvedValue(true);
      mockCacheInvalidate.mockResolvedValue(1);

      mockFindUniqueWallet.mockImplementation(async ({ where }: any) => {
         if (where.address === walletAddress) {
            return {
               id: 'wallet-1',
               userId: 'user-1016',
               address: walletAddress,
            };
         }
         if (where.address === otherWalletAddress) {
            return {
               id: 'wallet-2',
               userId: 'other-user',
               address: otherWalletAddress,
            };
         }
         return null;
      });

      mockFindFirstCreator.mockImplementation(async ({ where }: any) => {
         const matches =
            where?.id === creatorId ||
            where?.handle === creatorId ||
            where?.id === walletAddress ||
            where?.handle === walletAddress ||
            where?.user?.stellarWallet?.address === walletAddress ||
            where?.OR?.some?.(
               (c: any) =>
                  c.id === creatorId ||
                  c.id === walletAddress ||
                  c.handle === handle ||
                  c.handle === walletAddress ||
                  c.user?.stellarWallet?.address === walletAddress
            );

         if (matches) {
            return sampleProfile;
         }
         return null;
      });

      mockUpdateCreator.mockImplementation(async ({ where, data }: any) => {
         return {
            ...sampleProfile,
            ...data,
            id: where.id,
            updatedAt: new Date(),
         };
      });

      mockCountKeyOwnership.mockResolvedValue(10);
      mockFindManyTrade.mockResolvedValue([]);
   });

   describe('GET /api/v1/creators/:wallet/profile', () => {
      it('returns the full profile with resolved avatar URL and social links', async () => {
         const res = await supertest(app).get(
            `/api/v1/creators/${walletAddress}/profile`
         );

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toMatchObject({
            creatorId,
            displayName: 'Creator 1016',
            avatarCid: 'bafybeifx7yeb55vpchqqio5',
            avatar_cid: 'bafybeifx7yeb55vpchqqio5',
            avatarUrl:
               'https://gateway.pinata.cloud/ipfs/bafybeifx7yeb55vpchqqio5',
            twitter: 'https://twitter.com/creator1016',
            website: 'https://creator1016.example.com',
            discord: 'https://discord.gg/creator1016',
            socialLinks: {
               twitter: 'https://twitter.com/creator1016',
               website: 'https://creator1016.example.com',
               discord: 'https://discord.gg/creator1016',
            },
         });
         expect(res.body.data.walletAddress).toBe(walletAddress);
      });

      it('resolves raw CID to Pinata gateway URL', async () => {
         mockFindFirstCreator.mockResolvedValueOnce({
            ...sampleProfile,
            avatarCid: 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco',
            avatarUrl: null,
         });

         const res = await supertest(app).get(
            `/api/v1/creators/${walletAddress}/profile`
         );

         expect(res.status).toBe(200);
         expect(res.body.data.avatarUrl).toBe(
            'https://gateway.pinata.cloud/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco'
         );
      });
   });

   describe('PUT /api/v1/creators/:wallet/profile', () => {
      it('allows the wallet owner to update display name, avatar CID, and social links', async () => {
         const updatePayload = {
            displayName: 'Brand New Name',
            avatar_cid:
               'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
            twitter: 'https://twitter.com/newhandle',
            website: 'https://newdomain.com',
            discord: 'https://discord.gg/newcommunity',
         };

         const headers = createSignedHeaders(updatePayload, keypair);

         const res = await supertest(app)
            .put(`/api/v1/creators/${walletAddress}/profile`)
            .set(headers)
            .send(updatePayload);

         expect(res.status).toBe(202);
         expect(res.body.success).toBe(true);
         expect(res.body.data.acceptedProfile).toMatchObject({
            displayName: 'Brand New Name',
            avatar_cid:
               'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
            avatarUrl:
               'https://gateway.pinata.cloud/ipfs/bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
            twitter: 'https://twitter.com/newhandle',
            website: 'https://newdomain.com/',
            discord: 'https://discord.gg/newcommunity',
         });

         // Verifies Prisma update
         expect(mockUpdateCreator).toHaveBeenCalledWith(
            expect.objectContaining({
               where: { id: creatorId },
               data: expect.objectContaining({
                  displayName: 'Brand New Name',
                  avatarCid:
                     'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
                  avatarUrl:
                     'https://gateway.pinata.cloud/ipfs/bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
                  twitter: 'https://twitter.com/newhandle',
                  website: 'https://newdomain.com/',
                  discord: 'https://discord.gg/newcommunity',
               }),
            })
         );

         // Verifies cache invalidation is invoked immediately
         expect(mockCacheInvalidate).toHaveBeenCalledWith(
            expect.stringContaining(`creator:profile:${creatorId}`),
            expect.stringContaining(`creator:profile:${handle}`),
            expect.stringContaining(`creator:profile:${walletAddress}`),
            'creators:*',
            'creator:*'
         );
         expect(mockResetCreatorListCache).toHaveBeenCalled();
      });

      it('rejects update with 403 when signature is signed by a different non-owner wallet', async () => {
         const updatePayload = {
            displayName: 'Malicious Hijack',
         };

         const headers = createSignedHeaders(updatePayload, otherKeypair);

         const res = await supertest(app)
            .put(`/api/v1/creators/${walletAddress}/profile`)
            .set(headers)
            .send(updatePayload);

         expect(res.status).toBe(403);
         expect(res.body.success).toBe(false);
         expect(mockUpdateCreator).not.toHaveBeenCalled();
      });

      it('rejects update with 401 when signature headers are incomplete', async () => {
         const updatePayload = {
            displayName: 'No Timestamp',
         };

         const res = await supertest(app)
            .put(`/api/v1/creators/${walletAddress}/profile`)
            .set('x-wallet-address', walletAddress)
            .set('x-wallet-signature', 'c29tZXNpZ25hdHVyZQ==')
            .send(updatePayload);

         expect(res.status).toBe(401);
         expect(mockUpdateCreator).not.toHaveBeenCalled();
      });

      it('rejects update with 403 when signature is invalid', async () => {
         const updatePayload = {
            displayName: 'Invalid Signature',
         };
         const headers = createSignedHeaders(updatePayload, keypair);

         const res = await supertest(app)
            .put(`/api/v1/creators/${walletAddress}/profile`)
            .set({
               ...headers,
               'x-wallet-signature': Buffer.alloc(64, 1).toString('base64'),
            })
            .send(updatePayload);

         expect(res.status).toBe(403);
         expect(mockUpdateCreator).not.toHaveBeenCalled();
      });

      it('validates social link fields and rejects invalid URLs with 422', async () => {
         const invalidPayload = {
            twitter: 'not-a-valid-url',
         };

         const headers = createSignedHeaders(invalidPayload, keypair);

         const res = await supertest(app)
            .put(`/api/v1/creators/${walletAddress}/profile`)
            .set(headers)
            .send(invalidPayload);

         expect(res.status).toBe(422);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('VALIDATION_ERROR');
         expect(mockUpdateCreator).not.toHaveBeenCalled();
      });

      it('normalizes social links by stripping tracking parameters and lowercasing host', async () => {
         const updatePayload = {
            twitter:
               'https://Twitter.com/validhandle?utm_source=twitter&ref=share',
            website: 'https://MyWebsite.org/about/?utm_medium=social',
            discord: 'https://Discord.gg/servercode',
         };

         const headers = createSignedHeaders(updatePayload, keypair);

         const res = await supertest(app)
            .put(`/api/v1/creators/${walletAddress}/profile`)
            .set(headers)
            .send(updatePayload);

         expect(res.status).toBe(202);
         expect(mockUpdateCreator).toHaveBeenCalledWith(
            expect.objectContaining({
               data: expect.objectContaining({
                  twitter: 'https://twitter.com/validhandle',
                  website: 'https://mywebsite.org/about',
                  discord: 'https://discord.gg/servercode',
               }),
            })
         );
      });
   });

   describe('Public creator profile integration (/api/v1/creators/:id)', () => {
      it('reflects updated social links and resolved avatar URL on the public profile endpoint', async () => {
         const res = await supertest(app).get(`/api/v1/creators/${creatorId}`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toMatchObject({
            id: creatorId,
            displayName: 'Creator 1016',
            avatarUrl:
               'https://gateway.pinata.cloud/ipfs/bafybeifx7yeb55vpchqqio5',
            avatarCid: 'bafybeifx7yeb55vpchqqio5',
            twitter: 'https://twitter.com/creator1016',
            website: 'https://creator1016.example.com',
            discord: 'https://discord.gg/creator1016',
            socialLinks: {
               twitter: 'https://twitter.com/creator1016',
               website: 'https://creator1016.example.com',
               discord: 'https://discord.gg/creator1016',
            },
         });
      });
   });
});
