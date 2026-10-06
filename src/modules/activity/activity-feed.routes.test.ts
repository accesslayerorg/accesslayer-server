import request from 'supertest';
import app from '../../app';
import * as activityFeedService from './activity-feed.service';
import { disconnectRedis } from '../../utils/redis.utils';

jest.mock('../../utils/redis.utils', () => {
   const actual = jest.requireActual('../../utils/redis.utils');
   return {
      ...actual,
      cacheGetJson: jest.fn().mockResolvedValue(null),
      cacheSetJson: jest.fn().mockResolvedValue(undefined),
      cacheInvalidate: jest.fn().mockResolvedValue(undefined),
   };
});

describe('GET /activity/feed', () => {
   afterAll(async () => {
      await disconnectRedis();
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('returns the platform activity feed, reverse-chronological', async () => {
      const mockResult: activityFeedService.ActivityFeedResult = {
         items: [
            {
               type: 'investment',
               invoice_id: 'act-1',
               amount: '100',
               wallet: 'GABC…WXYZ',
               timestamp: '2026-09-27T00:00:00.000Z',
            },
            {
               type: 'new_listing',
               invoice_id: 'act-2',
               amount: null,
               wallet: 'GDEF…UVWX',
               timestamp: '2026-09-26T00:00:00.000Z',
            },
         ],
         next_cursor: null,
         has_more: false,
      };

      jest
         .spyOn(activityFeedService, 'getActivityFeed')
         .mockResolvedValueOnce(mockResult);

      const res = await request(app).get('/api/v1/activity/feed');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(2);
      expect(res.body.data.items[0].type).toBe('investment');
      expect(res.body.data.has_more).toBe(false);
   });

   it('paginates with a cursor for older events', async () => {
      const spy = jest
         .spyOn(activityFeedService, 'getActivityFeed')
         .mockResolvedValueOnce({
            items: [],
            next_cursor: null,
            has_more: false,
         });

      const res = await request(app).get('/api/v1/activity/feed?cursor=act-2');
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith('act-2');
   });

   it('returns 400 for unknown query parameters', async () => {
      const res = await request(app).get('/api/v1/activity/feed?bogus=1');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
   });
});
