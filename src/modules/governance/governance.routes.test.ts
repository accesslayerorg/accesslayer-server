import request from 'supertest';
import app from '../../app';
import * as governanceEscalationService from './governance-escalation.service';
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

describe('GET /governance/proposals/escalating', () => {
   afterAll(async () => {
      await disconnectRedis();
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('returns escalating proposals with participation rate and deadlines', async () => {
      jest
         .spyOn(governanceEscalationService, 'getEscalatingProposals')
         .mockResolvedValueOnce({
            items: [
               {
                  keyId: 'key-1',
                  proposalId: 'prop-1',
                  title: 'Increase treasury allocation',
                  status: 'active',
                  escalationCount: 2,
                  maxEscalations: 3,
                  originalDeadline: '2026-09-01T00:00:00.000Z',
                  extendedDeadline: '2026-09-15T00:00:00.000Z',
                  escalatedAt: '2026-09-10T00:00:00.000Z',
                  participationRate: 0.42,
               },
            ],
            next_cursor: null,
            has_more: false,
         });

      const res = await request(app).get(
         '/api/v1/governance/proposals/escalating'
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].escalationCount).toBe(2);
      expect(res.body.data.items[0].participationRate).toBe(0.42);
      expect(res.body.data.items[0].extendedDeadline).toBe(
         '2026-09-15T00:00:00.000Z'
      );
   });

   it('returns an empty list when nothing is escalating', async () => {
      jest
         .spyOn(governanceEscalationService, 'getEscalatingProposals')
         .mockResolvedValueOnce({
            items: [],
            next_cursor: null,
            has_more: false,
         });

      const res = await request(app).get(
         '/api/v1/governance/proposals/escalating'
      );
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
   });

   it('returns 400 for unknown query parameters', async () => {
      const res = await request(app).get(
         '/api/v1/governance/proposals/escalating?bogus=1'
      );
      expect(res.status).toBe(400);
   });
});
