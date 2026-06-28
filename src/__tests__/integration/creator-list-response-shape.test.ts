import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

const FIXTURE_SIZE = 150;
const MAX_PAGE_SIZE = 100;

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

describe('GET /api/v1/creators — response shape consistency across page sizes', () => {
  beforeAll(async () => {
    const usersToCreate = Array.from({ length: FIXTURE_SIZE }).map((_, i) => ({
      id: `shape-test-user-${i}`,
      email: `shape-test-user-${i}@example.com`,
      passwordHash: 'dummy-hash',
      firstName: 'Shape',
      lastName: `TestUser ${i}`,
    }));

    await prisma.user.createMany({
      data: usersToCreate,
      skipDuplicates: true,
    });

    const creatorsToCreate = Array.from({ length: FIXTURE_SIZE }).map((_, i) => ({
      userId: `shape-test-user-${i}`,
      handle: `shape-test-creator-${i}`,
      displayName: `Shape Test Creator ${i}`,
    }));

    await prisma.creatorProfile.createMany({
      data: creatorsToCreate,
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    await prisma.creatorProfile.deleteMany({
      where: { handle: { startsWith: 'shape-test-creator-' } },
    });

    await prisma.user.deleteMany({
      where: { id: { startsWith: 'shape-test-user-' } },
    });

    await prisma.$disconnect();
  });

  async function fetchPage(limit: number): Promise<ResponseEnvelope> {
    const res = await supertest(app).get(`/api/v1/creators?limit=${limit}`);
    expect(res.status).toBe(200);
    return res.body as ResponseEnvelope;
  }

  it('returns the same top-level response envelope shape for all page sizes', async () => {
    const [page1, page10, page100] = await Promise.all([
      fetchPage(1),
      fetchPage(10),
      fetchPage(MAX_PAGE_SIZE),
    ]);

    const topLevelKeys = ['success', 'data'];
    expect(Object.keys(page1).sort()).toEqual(topLevelKeys);
    expect(Object.keys(page10).sort()).toEqual(topLevelKeys);
    expect(Object.keys(page100).sort()).toEqual(topLevelKeys);

    const dataKeys = ['items', 'meta'];
    expect(Object.keys(page1.data).sort()).toEqual(dataKeys);
    expect(Object.keys(page10.data).sort()).toEqual(dataKeys);
    expect(Object.keys(page100.data).sort()).toEqual(dataKeys);

    const metaKeys = ['limit', 'offset', 'total', 'hasMore'];
    expect(Object.keys(page1.data.meta).sort()).toEqual(metaKeys);
    expect(Object.keys(page10.data.meta).sort()).toEqual(metaKeys);
    expect(Object.keys(page100.data.meta).sort()).toEqual(metaKeys);
  });

  it('returns items arrays whose lengths match the requested page size', async () => {
    const [page1, page10, page100] = await Promise.all([
      fetchPage(1),
      fetchPage(10),
      fetchPage(MAX_PAGE_SIZE),
    ]);

    expect(page1.data.items).toHaveLength(1);
    expect(page10.data.items).toHaveLength(10);
    expect(page100.data.items).toHaveLength(MAX_PAGE_SIZE);
  });

  it('returns pagination metadata that reflects the requested page size', async () => {
    const [page1, page10, page100] = await Promise.all([
      fetchPage(1),
      fetchPage(10),
      fetchPage(MAX_PAGE_SIZE),
    ]);

    expect(page1.data.meta).toMatchObject({
      limit: 1,
      offset: 0,
      total: FIXTURE_SIZE,
      hasMore: true,
    });

    expect(page10.data.meta).toMatchObject({
      limit: 10,
      offset: 0,
      total: FIXTURE_SIZE,
      hasMore: true,
    });

    expect(page100.data.meta).toMatchObject({
      limit: MAX_PAGE_SIZE,
      offset: 0,
      total: FIXTURE_SIZE,
      hasMore: true,
    });
  });
});
