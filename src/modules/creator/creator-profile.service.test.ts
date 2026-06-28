import {
   getCreatorProfile,
   upsertCreatorProfile,
} from './creator-profile.service';
import { UpsertCreatorProfileBodySchema } from './creator-profile.schemas';

const updateMock = jest.fn();
const findFirstMock = jest.fn();

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: (...args: unknown[]) => findFirstMock(...args),
         update: (...args: unknown[]) => updateMock(...args),
      },
   },
}));

describe('getCreatorProfile', () => {
   beforeEach(() => {
      findFirstMock.mockReset();
      updateMock.mockReset();
   });

   it('returns the placeholder profile shape for the requested creator id', async () => {
      findFirstMock.mockResolvedValue(null);

      const result = await getCreatorProfile('creator-1');

      expect(result).toEqual({
         creatorId: 'creator-1',
         displayName: null,
         bio: null,
         avatarUrl: null,
         createdAt: null,
         updatedAt: null,
         perks: [],
         links: [],
         currentPrice: null,
         price24hAgo: null,
         priceChange24h: null,
         metadata: {
            source: 'placeholder',
            isProfileComplete: false,
         },
      });
   });

   it('echoes the creator id verbatim so callers can correlate the response', async () => {
      findFirstMock.mockResolvedValue(null);

      const result = await getCreatorProfile('whatever-id-123');
      expect(result.creatorId).toBe('whatever-id-123');
   });
});

describe('upsertCreatorProfile', () => {
   beforeEach(() => {
      findFirstMock.mockReset();
      updateMock.mockReset();
      updateMock.mockResolvedValue({ id: 'creator-1' });
   });

   it('returns the placeholder envelope with the accepted payload', async () => {
      const payload = UpsertCreatorProfileBodySchema.parse({
         displayName: 'Alice Example',
         bio: 'Building things.',
         links: [{ label: 'site', url: 'https://example.com' }],
      });
      updateMock.mockResolvedValueOnce({ id: 'creator-1' });

      const result = await upsertCreatorProfile('creator-1', payload);

      expect(result).toEqual({
         creatorId: 'creator-1',
         acceptedProfile: payload,
         metadata: { source: 'database', persisted: true },
      });
   });

   it('flags persisted=true once the backing storage update succeeds', async () => {
      const payload = UpsertCreatorProfileBodySchema.parse({
         displayName: 'Bob',
      });
      updateMock.mockResolvedValueOnce({ id: 'creator-2' });

      const result = await upsertCreatorProfile('creator-2', payload);

      expect(result.metadata.persisted).toBe(true);
      expect(result.metadata.source).toBe('database');
   });

   it('rejects an invalid payload at the schema boundary, not in the service', () => {
      // Service trusts validated input — schema is the gate. This documents
      // the boundary so future contributors do not duplicate validation.
      const invalid = UpsertCreatorProfileBodySchema.safeParse({
         displayName: 'A', // shorter than 2 chars
      });
      expect(invalid.success).toBe(false);
   });

   it('accepts the maximum number of allowed links without truncation', async () => {
      const links = Array.from({ length: 8 }, (_, idx) => ({
         label: `link-${idx}`,
         url: `https://example.com/${idx}`,
      }));
      const payload = UpsertCreatorProfileBodySchema.parse({ links });

      const result = await upsertCreatorProfile('creator-3', payload);

      expect(result.acceptedProfile.links).toHaveLength(8);
   });

   it('truncates long write payload fields before persistence', async () => {
      const longDisplayName = 'A'.repeat(120);
      const longBio = 'B'.repeat(1200);
      const longLabel = 'L'.repeat(80);
      const longTitle = 'T'.repeat(140);
      const longDescription = 'D'.repeat(700);

      const result = await upsertCreatorProfile('creator-4', {
         displayName: longDisplayName,
         bio: longBio,
         links: [
            {
               label: longLabel,
               url: 'https://example.com',
            },
         ],
         perks: [
            {
               title: longTitle,
               description: longDescription,
            },
         ],
      } as never);

      expect(result.acceptedProfile.displayName).toHaveLength(80);
      expect(result.acceptedProfile.bio).toHaveLength(1000);
      expect(result.acceptedProfile.links?.[0]?.label).toHaveLength(40);
      expect(result.acceptedProfile.perks?.[0]?.title).toHaveLength(100);
      expect(result.acceptedProfile.perks?.[0]?.description).toHaveLength(500);
      expect(updateMock).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { id: 'creator-4' },
            data: expect.objectContaining({
               displayName: expect.any(String),
               bio: expect.any(String),
            }),
         })
      );
   });

   it('truncates multi-byte payload fields to byte limits before persistence', async () => {
      const result = await upsertCreatorProfile('creator-5', {
         displayName: '你'.repeat(40),
         bio: '界'.repeat(400),
         links: [
            {
               label: '名'.repeat(20),
               url: 'https://example.com',
            },
         ],
         perks: [
            {
               title: '礼'.repeat(60),
               description: '品'.repeat(250),
            },
         ],
      } as never);

      expect(
         Buffer.byteLength(result.acceptedProfile.displayName ?? '', 'utf8')
      ).toBeLessThanOrEqual(80);
      expect(
         Buffer.byteLength(result.acceptedProfile.bio ?? '', 'utf8')
      ).toBeLessThanOrEqual(1000);
      expect(
         Buffer.byteLength(
            result.acceptedProfile.links?.[0]?.label ?? '',
            'utf8'
         )
      ).toBeLessThanOrEqual(40);
      expect(
         Buffer.byteLength(
            result.acceptedProfile.perks?.[0]?.title ?? '',
            'utf8'
         )
      ).toBeLessThanOrEqual(100);
      expect(
         Buffer.byteLength(
            result.acceptedProfile.perks?.[0]?.description ?? '',
            'utf8'
         )
      ).toBeLessThanOrEqual(500);
   });
});
