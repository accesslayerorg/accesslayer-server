import {
   buildCanonicalParamString,
   buildCacheKey,
} from './cache-key-params.utils';

describe('buildCanonicalParamString()', () => {
   it('produces identical output regardless of input key order', () => {
      const setA = buildCanonicalParamString({
         order: 'desc',
         limit: 20,
         sort: 'createdAt',
         offset: 0,
      });

      const setB = buildCanonicalParamString({
         limit: 20,
         offset: 0,
         sort: 'createdAt',
         order: 'desc',
      });

      expect(setA).toBe(setB);
   });

   it('sorts keys lexicographically', () => {
      const result = buildCanonicalParamString({
         z: 'last',
         a: 'first',
         m: 'mid',
      });
      expect(result).toBe('a:first:m:mid:z:last');
   });

   it('omits undefined values', () => {
      const result = buildCanonicalParamString({
         limit: 20,
         search: undefined,
         verified: undefined,
      });
      expect(result).toBe('limit:20');
   });

   it('includes boolean values', () => {
      const result = buildCanonicalParamString({ verified: true, limit: 10 });
      expect(result).toBe('limit:10:verified:true');
   });

   it('returns an empty string when all values are undefined', () => {
      const result = buildCanonicalParamString({
         search: undefined,
         verified: undefined,
      });
      expect(result).toBe('');
   });

   it('returns an empty string for an empty params object', () => {
      expect(buildCanonicalParamString({})).toBe('');
   });

   it('two equivalent creator feed param sets produce the same cache key fragment', () => {
      const paramsA = buildCanonicalParamString({
         limit: 20,
         offset: 0,
         sort: 'createdAt',
         order: 'desc',
         verified: true,
         search: 'example',
      });

      const paramsB = buildCanonicalParamString({
         search: 'example',
         verified: true,
         order: 'desc',
         sort: 'createdAt',
         offset: 0,
         limit: 20,
      });

      expect(paramsA).toBe(paramsB);
      expect(paramsA).toBe(
         'limit:20:offset:0:order:desc:search:example:sort:createdAt:verified:true'
      );
   });
});

describe('buildCacheKey()', () => {
   it('produces identical cache keys for identical params in different order', () => {
      const keyA = buildCacheKey('creator:123', {
         limit: 20,
         sort: 'createdAt',
         order: 'desc',
      });
      const keyB = buildCacheKey('creator:123', {
         order: 'desc',
         limit: 20,
         sort: 'createdAt',
      });

      expect(keyA).toBe(keyB);
   });

   it('produces different cache keys for different params', () => {
      const keyA = buildCacheKey('creator:123', {
         limit: 20,
         sort: 'createdAt',
      });
      const keyB = buildCacheKey('creator:123', {
         limit: 10,
         sort: 'createdAt',
      });

      expect(keyA).not.toBe(keyB);
   });

   it('returns a string of fixed length format', () => {
      const key1 = buildCacheKey('creator:123', { limit: 20 });
      const key2 = buildCacheKey('creator:123', {
         limit: 100,
         offset: 500,
         sort: 'verylongsortfieldname',
         search: 'searching for something very long and detailed',
      });

      expect(typeof key1).toBe('string');
      expect(typeof key2).toBe('string');
      // Base prefix ('creator:123:') + 16 chars hash hex = 28 length
      expect(key1.length).toBe(key2.length);
      expect(key1).toMatch(/^creator:123:[a-f0-9]{16}$/);
      expect(key2).toMatch(/^creator:123:[a-f0-9]{16}$/);
   });
});
