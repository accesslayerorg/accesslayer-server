import { Response } from 'express';
import {
   attachPaginationLinkHeaders,
   buildPaginationLinkHeader,
   PAGINATION_LINK_HEADER,
} from './pagination-link-headers.utils';

const BASE_URL = 'https://api.example.com/creators';

const mockRes = () => ({ set: jest.fn() }) as unknown as Response;

describe('buildPaginationLinkHeader()', () => {
   it('returns null when the result fits on a single page', () => {
      const result = buildPaginationLinkHeader({
         baseUrl: BASE_URL,
         query: {},
         offset: 0,
         limit: 20,
         total: 10,
      });
      expect(result).toBeNull();
   });

   it('returns only next for the first page', () => {
      const result = buildPaginationLinkHeader({
         baseUrl: BASE_URL,
         query: {},
         offset: 0,
         limit: 10,
         total: 25,
      });
      expect(result).toContain('rel="next"');
      expect(result).not.toContain('rel="prev"');
   });

   it('returns only prev for the last page', () => {
      const result = buildPaginationLinkHeader({
         baseUrl: BASE_URL,
         query: {},
         offset: 20,
         limit: 10,
         total: 25,
      });
      expect(result).toContain('rel="prev"');
      expect(result).not.toContain('rel="next"');
   });

   it('returns both next and prev for a middle page', () => {
      const result = buildPaginationLinkHeader({
         baseUrl: BASE_URL,
         query: {},
         offset: 10,
         limit: 10,
         total: 30,
      });
      expect(result).toContain('rel="next"');
      expect(result).toContain('rel="prev"');
   });

   it('encodes the correct offset values in link URLs', () => {
      const result = buildPaginationLinkHeader({
         baseUrl: BASE_URL,
         query: {},
         offset: 10,
         limit: 10,
         total: 30,
      });
      expect(result).toContain('offset=20');
      expect(result).toContain('offset=0');
   });

   it('preserves existing query parameters in link URLs', () => {
      const result = buildPaginationLinkHeader({
         baseUrl: BASE_URL,
         query: { sort: 'createdAt', verified: true },
         offset: 0,
         limit: 10,
         total: 20,
      });
      expect(result).toContain('sort=createdAt');
      expect(result).toContain('verified=true');
   });

   it('does not duplicate offset or limit from the source query', () => {
      const result = buildPaginationLinkHeader({
         baseUrl: BASE_URL,
         query: { offset: 0, limit: 10 },
         offset: 0,
         limit: 10,
         total: 20,
      });
      const nextLink = result?.split(',')[0] ?? '';
      const params = new URLSearchParams(nextLink.match(/\?([^>]+)/)?.[1] ?? '');
      expect(params.getAll('offset')).toHaveLength(1);
      expect(params.getAll('limit')).toHaveLength(1);
   });

   it('clamps prev offset to 0 when offset < limit', () => {
      const result = buildPaginationLinkHeader({
         baseUrl: BASE_URL,
         query: {},
         offset: 5,
         limit: 10,
         total: 30,
      });
      expect(result).toContain('offset=0');
   });
});

describe('attachPaginationLinkHeaders()', () => {
   it('sets the Link header when adjacent pages exist', () => {
      const res = mockRes();
      attachPaginationLinkHeaders(res, {
         baseUrl: BASE_URL,
         query: {},
         offset: 0,
         limit: 10,
         total: 25,
      });
      expect(res.set).toHaveBeenCalledWith(
         PAGINATION_LINK_HEADER,
         expect.stringContaining('rel="next"'),
      );
   });

   it('does not set Link header when result is single-page', () => {
      const res = mockRes();
      attachPaginationLinkHeaders(res, {
         baseUrl: BASE_URL,
         query: {},
         offset: 0,
         limit: 20,
         total: 10,
      });
      expect(res.set).not.toHaveBeenCalled();
   });
});
