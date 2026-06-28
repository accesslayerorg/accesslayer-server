import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

const FIXTURE_SIZE = 50;
const CONCURRENT_REQUESTS = 3;

interface PaginationMeta {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
}

interface ResponseEnvelope {
  success: boolean;
  data: {
    items: unknown[];
    meta: PaginationMeta;
  };
}

describe('GET /api/v1/creators — concurrent requests return consistent results', () => {
  beforeAll(async () => {
    const usersToCreate = Array.from({ length: FIXTURE_SIZE }).map((_, i) => ({
      id: `concurrent-test-user-${i}`,
      email: `concurrent-test-user-${i}@example.com`,
      passwordHash: 'dummy-hash',
      firstName: 'Concurrent',
      lastName: `TestUser ${i}`,
    }));

    await prisma.user.createMany({
      data: usersToCreate,
      skipDuplicates: true,
    });

    const creatorsToCreate = Array.from({ length: FIXTURE_SIZE }).map((_, i) => ({
      userId: `concurrent-test-user-${i}`,
      handle: `concurrent-test-creator-${i}`,
      displayName: `Concurrent Test Creator ${i}`,
    }));

    await prisma.creatorProfile.createMany({
      data: creatorsToCreate,
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    await prisma.creatorProfile.deleteMany({
      where: { handle: { startsWith: 'concurrent-test-creator-' } },
    });

    await prisma.user.deleteMany({
      where: { id: { startsWith: 'concurrent-test-user-' } },
    });

    await prisma.$disconnect();
  });

  it('returns identical item sets and metadata across simultaneous requests', async () => {
    const requests = Array.from({ length: CONCURRENT_REQUESTS }, () =>
      supertest(app).get('/api/v1/creators?limit=20')
    );

    const responses = await Promise.all(requests);

    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    const bodies = responses.map((r) => r.body as ResponseEnvelope);

    for (let i = 1; i < bodies.length; i++) {
      expect(bodies[i].success).toBe(bodies[0].success);
      expect(bodies[i].data.items).toEqual(bodies[0].data.items);
      expect(bodies[i].data.meta).toEqual(bodies[0].data.meta);
    }
  });

  it('returns the same total count across all concurrent requests', async () => {
    const requests = Array.from({ length: CONCURRENT_REQUESTS }, () =>
      supertest(app).get('/api/v1/creators?limit=10')
    );

    const responses = await Promise.all(requests);

    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    const bodies = responses.map((r) => r.body as ResponseEnvelope);

    for (const body of bodies) {
      expect(body.data.meta.total).toBe(FIXTURE_SIZE);
    }
  });
});
