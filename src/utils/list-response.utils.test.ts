/**
 * Unit tests for buildListResponse helper.
 *
 * Verifies the response envelope shape for:
 * - Offset pagination (no cursor)
 * - Cursor pagination (with cursor)
 * - Empty data arrays
 */

import { buildListResponse, ListResponse } from './list-response.utils';

describe('buildListResponse', () => {
   // ── With cursor ─────────────────────────────────────────────────────────

   it('returns correct envelope shape with nextCursor', () => {
      const items = [{ id: '1' }, { id: '2' }, { id: '3' }];
      const result = buildListResponse(items, {
         total: 10,
         hasMore: true,
         nextCursor: 'eyJpZCI6M30=',
      });

      expect(result).toEqual({
         data: items,
         meta: {
            total: 10,
            hasMore: true,
            nextCursor: 'eyJpZCI6M30=',
         },
      });
   });

   it('includes nextCursor in meta when provided', () => {
      const result = buildListResponse([{ id: 'a' }], {
         total: 5,
         hasMore: true,
         nextCursor: 'cursor-abc',
      });

      expect(result.meta).toHaveProperty('nextCursor', 'cursor-abc');
   });

   it('preserves data array reference when cursor is present', () => {
      const items = [{ value: 100 }];
      const result = buildListResponse(items, {
         total: 20,
         hasMore: true,
         nextCursor: 'xyz',
      });

      expect(result.data).toBe(items);
   });

   // ── Without cursor ──────────────────────────────────────────────────────

   it('omits nextCursor from output when undefined', () => {
      const items = [{ id: '1' }, { id: '2' }];
      const result = buildListResponse(items, {
         total: 2,
         hasMore: false,
      });

      expect(result).toEqual({
         data: items,
         meta: {
            total: 2,
            hasMore: false,
         },
      });
      expect(result.meta).not.toHaveProperty('nextCursor');
   });

   it('does not serialize nextCursor when not provided', () => {
      const result = buildListResponse([{ id: '1' }], {
         total: 1,
         hasMore: false,
      });

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('nextCursor');
   });

   it('returns correct shape for offset pagination without cursor', () => {
      const items = [{ id: 'x' }, { id: 'y' }];
      const result = buildListResponse(items, {
         total: 50,
         hasMore: true,
      });

      expect(Object.keys(result)).toEqual(['data', 'meta']);
      expect(Object.keys(result.meta).sort()).toEqual(['hasMore', 'total']);
   });

   // ── Empty data array ────────────────────────────────────────────────────

   it('returns correct shape for empty data array', () => {
      const result = buildListResponse([], {
         total: 0,
         hasMore: false,
      });

      expect(result).toEqual({
         data: [],
         meta: {
            total: 0,
            hasMore: false,
         },
      });
   });

   it('returns empty array with total: 0 and hasMore: false for no results', () => {
      const result = buildListResponse([], {
         total: 0,
         hasMore: false,
      });

      expect(result.data).toEqual([]);
      expect(result.meta.total).toBe(0);
      expect(result.meta.hasMore).toBe(false);
   });

   it('omits nextCursor from empty result when undefined', () => {
      const result = buildListResponse([], {
         total: 0,
         hasMore: false,
      });

      expect(result.meta).not.toHaveProperty('nextCursor');
   });

   it('handles empty array with cursor (edge case)', () => {
      const result = buildListResponse([], {
         total: 0,
         hasMore: false,
         nextCursor: 'cursor-empty',
      });

      expect(result).toEqual({
         data: [],
         meta: {
            total: 0,
            hasMore: false,
            nextCursor: 'cursor-empty',
         },
      });
   });

   // ── Type safety ─────────────────────────────────────────────────────────

   it('preserves generic type of data array', () => {
      interface User {
         id: string;
         name: string;
      }

      const users: User[] = [
         { id: '1', name: 'Alice' },
         { id: '2', name: 'Bob' },
      ];

      const result: ListResponse<User> = buildListResponse(users, {
         total: 2,
         hasMore: false,
      });

      expect(result.data[0].name).toBe('Alice');
      expect(result.data[1].name).toBe('Bob');
   });

   it('handles different data types correctly', () => {
      const numbers = [1, 2, 3, 4, 5];
      const result = buildListResponse(numbers, {
         total: 5,
         hasMore: false,
      });

      expect(result.data).toEqual([1, 2, 3, 4, 5]);
   });

   // ── Meta field validation ───────────────────────────────────────────────

   it('includes all required meta fields', () => {
      const result = buildListResponse([{ id: '1' }], {
         total: 10,
         hasMore: true,
      });

      expect(result.meta).toHaveProperty('total');
      expect(result.meta).toHaveProperty('hasMore');
   });

   it('preserves meta.total value exactly', () => {
      const result = buildListResponse([], {
         total: 999,
         hasMore: true,
      });

      expect(result.meta.total).toBe(999);
   });

   it('preserves meta.hasMore boolean value', () => {
      const resultTrue = buildListResponse([], {
         total: 10,
         hasMore: true,
      });
      const resultFalse = buildListResponse([], {
         total: 10,
         hasMore: false,
      });

      expect(resultTrue.meta.hasMore).toBe(true);
      expect(resultFalse.meta.hasMore).toBe(false);
   });

   // ── Edge cases ──────────────────────────────────────────────────────────

   it('handles empty string as nextCursor', () => {
      const result = buildListResponse([{ id: '1' }], {
         total: 1,
         hasMore: false,
         nextCursor: '',
      });

      expect(result.meta.nextCursor).toBe('');
      expect(result.meta).toHaveProperty('nextCursor');
   });

   it('handles large data arrays', () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
      const result = buildListResponse(largeArray, {
         total: 10000,
         hasMore: true,
         nextCursor: 'next-1000',
      });

      expect(result.data.length).toBe(1000);
      expect(result.meta.total).toBe(10000);
   });

   it('returns new meta object (not mutating input)', () => {
      const inputMeta = {
         total: 5,
         hasMore: true,
         nextCursor: 'abc',
      };

      const result = buildListResponse([{ id: '1' }], inputMeta);

      expect(result.meta).not.toBe(inputMeta);
      expect(result.meta).toEqual(inputMeta);
   });
});
