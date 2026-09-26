import supertest from 'supertest';
import app from '../../app';

describe('Creator list stable sort with tied values', () => {
   it('returns consistent order across repeated requests', async () => {
      const first = await supertest(app)
         .get('/api/v1/creators')
         .query({ sort: 'price', order: 'asc', limit: '10' });

      const second = await supertest(app)
         .get('/api/v1/creators')
         .query({ sort: 'price', order: 'asc', limit: '10' });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const firstHandles = (first.body.data || []).map((c: any) => c.handle);
      const secondHandles = (second.body.data || []).map((c: any) => c.handle);

      expect(firstHandles).toEqual(secondHandles);
   });

   it('does not duplicate creators across paginated pages', async () => {
      const page1 = await supertest(app)
         .get('/api/v1/creators')
         .query({ sort: 'price', order: 'asc', limit: '2' });

      const page2 = await supertest(app)
         .get('/api/v1/creators')
         .query({
            sort: 'price',
            order: 'asc',
            limit: '2',
            cursor: page1.body.meta?.nextCursor || '',
         });

      const page1Handles = (page1.body.data || []).map((c: any) => c.handle);
      const page2Handles = (page2.body.data || []).map((c: any) => c.handle);

      const allHandles = [...page1Handles, ...page2Handles];
      const unique = new Set(allHandles);
      expect(unique.size).toBe(allHandles.length);
   });
});
