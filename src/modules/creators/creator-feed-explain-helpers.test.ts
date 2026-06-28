/**
 * Unit tests for the SQL-building helpers that feed EXPLAIN queries.
 * These helpers must mirror the Prisma where-clause logic exactly so the
 * query plan reflects the real query shape.
 */

import {
   buildCreatorFeedExplainSql,
   buildCreatorFeedExplainParams,
} from './creators.utils';

describe('buildCreatorFeedExplainSql()', () => {
   it('returns a bare SELECT with no WHERE clause when the filter is empty', () => {
      const sql = buildCreatorFeedExplainSql({});
      expect(sql).toBe('SELECT * FROM "CreatorProfile" ');
   });

   it('adds an isVerified condition when verified is set', () => {
      const sql = buildCreatorFeedExplainSql({ isVerified: true });
      expect(sql).toContain('"isVerified" = $1');
      expect(sql).toContain('WHERE');
   });

   it('adds an OR ILIKE condition when a search term is present', () => {
      const sql = buildCreatorFeedExplainSql({
         OR: [
            { handle: { contains: 'jazz', mode: 'insensitive' } },
            { displayName: { contains: 'jazz', mode: 'insensitive' } },
         ],
      });
      expect(sql).toContain('"handle" ILIKE');
      expect(sql).toContain('"displayName" ILIKE');
      expect(sql).toContain('WHERE');
   });

   it('combines isVerified and OR conditions with AND', () => {
      const sql = buildCreatorFeedExplainSql({
         isVerified: true,
         OR: [
            { handle: { contains: 'jazz', mode: 'insensitive' } },
            { displayName: { contains: 'jazz', mode: 'insensitive' } },
         ],
      });
      expect(sql).toContain('"isVerified" = $1');
      expect(sql).toContain('AND');
      expect(sql).toContain('"handle" ILIKE $2');
      expect(sql).toContain('"displayName" ILIKE $3');
   });
});

describe('buildCreatorFeedExplainParams()', () => {
   it('returns an empty array when the filter is empty', () => {
      expect(buildCreatorFeedExplainParams({})).toEqual([]);
   });

   it('returns [true] for isVerified=true', () => {
      expect(buildCreatorFeedExplainParams({ isVerified: true })).toEqual([true]);
   });

   it('returns [false] for isVerified=false', () => {
      expect(buildCreatorFeedExplainParams({ isVerified: false })).toEqual([false]);
   });

   it('returns two ILIKE params wrapping the search term', () => {
      const params = buildCreatorFeedExplainParams({
         OR: [
            { handle: { contains: 'jazz', mode: 'insensitive' } },
            { displayName: { contains: 'jazz', mode: 'insensitive' } },
         ],
      });
      expect(params).toEqual(['%jazz%', '%jazz%']);
   });

   it('returns isVerified param first, then the two ILIKE params', () => {
      const params = buildCreatorFeedExplainParams({
         isVerified: false,
         OR: [
            { handle: { contains: 'rock', mode: 'insensitive' } },
            { displayName: { contains: 'rock', mode: 'insensitive' } },
         ],
      });
      expect(params).toEqual([false, '%rock%', '%rock%']);
   });
});
