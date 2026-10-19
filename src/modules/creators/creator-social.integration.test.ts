import supertest from 'supertest';
import { ErrorCode } from '../../constants/error.constants';
import { CREATOR_PUBLIC_ROUTE_CACHE_CONTROL_HEADER } from '../../constants/creator-public-cache.constants';

const creatorFindFirstMock = jest.fn();
const socialFindUniqueMock = jest.fn();
const walletFindFirstMock = jest.fn();

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      $disconnect: jest.fn(),
      creatorProfile: {
         findFirst: (...args: unknown[]) => creatorFindFirstMock(...args),
      },
      creatorSocialMetadata: {
         findUnique: (...args: unknown[]) => socialFindUniqueMock(...args),
      },
      stellarWallet: {
         findFirst: (...args: unknown[]) => walletFindFirstMock(...args),
      },
   },
}));

jest.mock('../creator/creator-profile.service', () => ({
   creatorProfileExists: jest.fn(),
   getCreatorProfile: jest.fn(),
}));

const SYNCED_SNAPSHOT = {
   displayName: 'Ada Artist',
   bio: 'On-chain bio',
   avatarCid: 'bafybeigdyrzt',
   avatarUrl: 'https://gateway.pinata.cloud/ipfs/bafybeigdyrzt',
   socialLinks: [
      { label: 'X', url: 'https://x.com/ada' },
      { label: 'Site', url: 'https://ada.example/' },
   ],
   sourceLedger: 500,
   sourceTxHash: 'tx-social-1',
   sourceEventIndex: 0,
   socialUpdatedAt: new Date('2026-10-17T10:00:00.000Z'),
};

describe('GET /api/v1/creators/:wallet/social', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      creatorFindFirstMock.mockResolvedValue({
         id: 'creator-1',
         handle: 'ada',
         userId: 'user-1',
      });
      walletFindFirstMock.mockResolvedValue({ address: 'GWALLET' });
      socialFindUniqueMock.mockResolvedValue(null);
   });

   it('returns the synced social metadata for a creator wallet', async () => {
      socialFindUniqueMock.mockResolvedValue(SYNCED_SNAPSHOT);
      const { default: app } = await import('../../app');

      const res = await supertest(app).get('/api/v1/creators/GWALLET/social');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
         creatorId: 'creator-1',
         handle: 'ada',
         wallet: 'GWALLET',
         displayName: 'Ada Artist',
         bio: 'On-chain bio',
         avatarUrl: 'https://gateway.pinata.cloud/ipfs/bafybeigdyrzt',
         avatarCid: 'bafybeigdyrzt',
         links: [
            { label: 'X', url: 'https://x.com/ada' },
            { label: 'Site', url: 'https://ada.example/' },
         ],
         synced: true,
         updatedAt: '2026-10-17T10:00:00.000Z',
         source: { ledger: 500, txHash: 'tx-social-1', eventIndex: 0 },
      });
   });

   it('caps the HTTP cache at 60 seconds so social updates propagate quickly', async () => {
      socialFindUniqueMock.mockResolvedValue(SYNCED_SNAPSHOT);
      const { default: app } = await import('../../app');

      const res = await supertest(app).get('/api/v1/creators/GWALLET/social');

      expect(res.headers['cache-control']).toContain('public');
      expect(res.headers['cache-control']).toContain('max-age=60');
      expect(CREATOR_PUBLIC_ROUTE_CACHE_CONTROL_HEADER.socialRead).toMatch(
         /max-age=60/
      );
   });

   it('returns synced=false with empty links when no event has been indexed yet', async () => {
      const { default: app } = await import('../../app');

      const res = await supertest(app).get('/api/v1/creators/GWALLET/social');

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
         creatorId: 'creator-1',
         displayName: null,
         bio: null,
         avatarUrl: null,
         avatarCid: null,
         links: [],
         synced: false,
         updatedAt: null,
         source: null,
      });
   });

   it('returns 404 with the standard error shape when no creator matches', async () => {
      creatorFindFirstMock.mockResolvedValue(null);
      const { default: app } = await import('../../app');

      const res = await supertest(app).get(
         '/api/v1/creators/GUNKNOWNSOCIAL/social'
      );

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatchObject({
         code: ErrorCode.NOT_FOUND,
         message: 'Creator not found',
      });
   });

   it('rejects malformed wallet params with a validation error', async () => {
      const { default: app } = await import('../../app');

      const res = await supertest(app).get(
         '/api/v1/creators/bad%20wallet/social'
      );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
   });

   it('rejects non-GET methods with 405 and an Allow header', async () => {
      const { default: app } = await import('../../app');

      const res = await supertest(app).post('/api/v1/creators/GWALLET/social');

      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe('GET');
   });
});
