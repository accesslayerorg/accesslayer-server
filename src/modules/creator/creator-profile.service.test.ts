import {
   getCreatorProfile,
   upsertCreatorProfile,
} from './creator-profile.service';
import { UpsertCreatorProfileBodySchema } from './creator-profile.schemas';

describe('getCreatorProfile', () => {
   it('returns the placeholder profile shape for the requested creator id', async () => {
      const result = await getCreatorProfile('creator-1');

      expect(result).toEqual({
         creatorId: 'creator-1',
         displayName: null,
         bio: null,
         avatarUrl: null,
         links: [],
         metadata: {
            source: 'placeholder',
            isProfileComplete: false,
         },
      });
   });

   it('echoes the creator id verbatim so callers can correlate the response', async () => {
      const result = await getCreatorProfile('whatever-id-123');
      expect(result.creatorId).toBe('whatever-id-123');
   });
});

describe('upsertCreatorProfile', () => {
   it('returns the placeholder envelope with the accepted payload', async () => {
      const payload = UpsertCreatorProfileBodySchema.parse({
         displayName: 'Alice Example',
         bio: 'Building things.',
         links: [{ label: 'site', url: 'https://example.com' }],
      });

      const result = await upsertCreatorProfile('creator-1', payload);

      expect(result).toEqual({
         creatorId: 'creator-1',
         acceptedProfile: payload,
         metadata: { source: 'placeholder', persisted: false },
      });
   });

   it('flags persisted=false until backing storage is wired up', async () => {
      const payload = UpsertCreatorProfileBodySchema.parse({
         displayName: 'Bob',
      });

      const result = await upsertCreatorProfile('creator-2', payload);

      expect(result.metadata.persisted).toBe(false);
      expect(result.metadata.source).toBe('placeholder');
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
});
