// src/modules/search/search.routes.test.ts
jest.mock('./search.service', () => {
   class SearchQueryTooShortError extends Error {}
   class InvalidSearchCursorError extends Error {}
   return {
      getGroupedSearch: jest.fn(),
      searchKeys: jest.fn(),
      searchCreators: jest.fn(),
      searchTransaction: jest.fn(),
      SearchQueryTooShortError,
      InvalidSearchCursorError,
   };
});

import express from 'express';
import request from 'supertest';
import searchRouter from './search.routes';
import {
   getGroupedSearch,
   InvalidSearchCursorError,
   searchCreators,
   searchKeys,
} from './search.service';

const mockGetGroupedSearch = getGroupedSearch as jest.Mock;
const mockSearchKeys = searchKeys as jest.Mock;
const mockSearchCreators = searchCreators as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1/search', searchRouter);

beforeEach(() => {
   jest.clearAllMocks();
});

describe('GET /api/v1/search', () => {
   it('returns grouped results for the overlay', async () => {
      const grouped = {
         query: 'al',
         keys: [{ keyId: 'k1' }],
         creators: [{ id: 'c1' }, { id: 'c2' }],
         transactions: [],
      };
      mockGetGroupedSearch.mockResolvedValue(grouped);

      const res = await request(app).get('/api/v1/search?q=al');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(grouped);
      expect(mockGetGroupedSearch).toHaveBeenCalledWith('al');
   });

   it('returns 400 when q is missing', async () => {
      const res = await request(app).get('/api/v1/search');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockGetGroupedSearch).not.toHaveBeenCalled();
   });

   it('returns 400 when q is shorter than the minimum length', async () => {
      const res = await request(app).get('/api/v1/search?q=a');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockGetGroupedSearch).not.toHaveBeenCalled();
   });
});

describe('GET /api/v1/search/keys', () => {
   it('passes the default limit and no cursor on the first page', async () => {
      mockSearchKeys.mockResolvedValue({
         items: [],
         nextCursor: null,
         hasMore: false,
         limit: 20,
      });

      const res = await request(app).get('/api/v1/search/keys?q=alice');

      expect(res.status).toBe(200);
      expect(mockSearchKeys).toHaveBeenCalledWith('alice', {
         limit: 20,
         cursor: undefined,
      });
   });

   it('forwards limit and cursor for pagination', async () => {
      mockSearchKeys.mockResolvedValue({
         items: [],
         nextCursor: null,
         hasMore: false,
         limit: 5,
      });

      const res = await request(app).get(
         '/api/v1/search/keys?q=alice&limit=5&cursor=cursor-token'
      );

      expect(res.status).toBe(200);
      expect(mockSearchKeys).toHaveBeenCalledWith('alice', {
         limit: 5,
         cursor: 'cursor-token',
      });
   });

   it('rejects limits above the maximum', async () => {
      const res = await request(app).get(
         '/api/v1/search/keys?q=alice&limit=101'
      );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockSearchKeys).not.toHaveBeenCalled();
   });

   it('returns 400 for a tampered cursor', async () => {
      mockSearchKeys.mockRejectedValue(new InvalidSearchCursorError());

      const res = await request(app).get(
         '/api/v1/search/keys?q=alice&cursor=tampered'
      );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
   });
});

describe('GET /api/v1/search/creators', () => {
   it('forwards pagination parameters to the creator search', async () => {
      mockSearchCreators.mockResolvedValue({
         items: [],
         nextCursor: null,
         hasMore: false,
         limit: 10,
      });

      const res = await request(app).get(
         '/api/v1/search/creators?q=GABC&limit=10&cursor=next'
      );

      expect(res.status).toBe(200);
      expect(mockSearchCreators).toHaveBeenCalledWith('GABC', {
         limit: 10,
         cursor: 'next',
      });
   });

   it('returns 400 when q is missing', async () => {
      const res = await request(app).get('/api/v1/search/creators');

      expect(res.status).toBe(400);
      expect(mockSearchCreators).not.toHaveBeenCalled();
   });
});
