// src/modules/sitemap/sitemap.service.test.ts
const mockCacheGetJson = jest.fn();
const mockCacheSetJson = jest.fn();
jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: (...args: unknown[]) => mockCacheGetJson(...args),
   cacheSetJson: (...args: unknown[]) => mockCacheSetJson(...args),
}));

const mockCount = jest.fn();
const mockFindMany = jest.fn();
const mockFreezeFindMany = jest.fn();
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         count: (...args: unknown[]) => mockCount(...args),
         findMany: (...args: unknown[]) => mockFindMany(...args),
      },
      keyFreeze: { findMany: (...args: unknown[]) => mockFreezeFindMany(...args) },
   },
}));

import {
   escapeXml,
   renderRobotsTxt,
   renderSitemapIndex,
   renderUrlSet,
   SITEMAP_CACHE_TTL_SECONDS,
   SITEMAP_PAGE_SIZE,
   SitemapService,
} from './sitemap.service';

const ORIGIN = 'https://accesslayer.example'; // PUBLIC_SITE_URL in jest.setup.ts

beforeEach(() => {
   jest.clearAllMocks();
   mockCacheGetJson.mockResolvedValue(null);
   mockFreezeFindMany.mockResolvedValue([]);
   mockCount.mockResolvedValue(0);
   mockFindMany.mockResolvedValue([]);
});

describe('SitemapService.index', () => {
   it('lists one entry per sitemap page using the public origin', async () => {
      mockCount.mockResolvedValue(SITEMAP_PAGE_SIZE * 2 + 1);

      const xml = await SitemapService.index();

      expect(xml.match(/<sitemap>/g)).toHaveLength(3);
      expect(xml).toContain(`<loc>${ORIGIN}/sitemaps/creators-1.xml</loc>`);
      expect(xml).toContain(`<loc>${ORIGIN}/sitemaps/creators-3.xml</loc>`);
      expect(xml).not.toContain('creators-4.xml');
   });

   it('keeps one (empty) page when there are no creators', async () => {
      const xml = await SitemapService.index();
      expect(xml.match(/<sitemap>/g)).toHaveLength(1);
   });

   it('uses exactly one page at the page-size boundary', async () => {
      mockCount.mockResolvedValue(SITEMAP_PAGE_SIZE);
      expect((await SitemapService.index()).match(/<sitemap>/g)).toHaveLength(1);
   });
});

describe('SitemapService.page', () => {
   it('emits creator URLs with lastmod from the latest update', async () => {
      const updatedAt = new Date('2026-11-01T10:00:00.000Z');
      mockCount.mockResolvedValue(1);
      mockFindMany.mockResolvedValue([{ handle: 'alice', updatedAt }]);

      const xml = await SitemapService.page(1);

      expect(xml).toContain(`<loc>${ORIGIN}/creators/alice</loc>`);
      expect(xml).toContain('<lastmod>2026-11-01T10:00:00.000Z</lastmod>');
   });

   it('never requests more than 10,000 URLs and offsets by page', async () => {
      mockCount.mockResolvedValue(SITEMAP_PAGE_SIZE * 3);

      await SitemapService.page(2);

      expect(SITEMAP_PAGE_SIZE).toBe(10_000);
      expect(mockFindMany).toHaveBeenCalledWith(
         expect.objectContaining({ skip: SITEMAP_PAGE_SIZE, take: SITEMAP_PAGE_SIZE })
      );
   });

   it('excludes deprecated, retired and sunset-flagged keys in the query', async () => {
      mockCount.mockResolvedValue(1);

      await SitemapService.page(1);

      const where = mockFindMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
         status: 'Active',
         deprecatedAt: null,
         sunsetFlaggedAt: null,
      });
   });

   it('excludes currently frozen keys but not ones whose freeze expired', async () => {
      const now = Date.now();
      mockFreezeFindMany.mockResolvedValue([
         { keyId: 'frozen-forever', expiryTimestamp: null },
         { keyId: 'frozen-until-later', expiryTimestamp: new Date(now + 60_000) },
         { keyId: 'freeze-expired', expiryTimestamp: new Date(now - 60_000) },
      ]);
      mockCount.mockResolvedValue(1);

      await SitemapService.page(1);

      const where = mockFindMany.mock.calls[0][0].where;
      expect(where.id.notIn).toEqual(['frozen-forever', 'frozen-until-later']);
   });

   it('percent-encodes and escapes handles so the XML stays valid', async () => {
      mockCount.mockResolvedValue(1);
      mockFindMany.mockResolvedValue([
         { handle: 'a&b<c>', updatedAt: new Date('2026-01-01T00:00:00.000Z') },
      ]);

      const xml = (await SitemapService.page(1)) as string;

      expect(xml).toContain('/creators/a%26b%3Cc%3E');
      expect(xml).not.toMatch(/<loc>[^<]*[&](?!amp;|lt;|gt;|quot;|apos;)/);
   });

   it('returns null for pages that do not exist or are malformed', async () => {
      mockCount.mockResolvedValue(5);

      expect(await SitemapService.page(2)).toBeNull();
      expect(await SitemapService.page(0)).toBeNull();
      expect(await SitemapService.page(-1)).toBeNull();
      expect(await SitemapService.page(1.5)).toBeNull();
      expect(await SitemapService.page(Number.NaN)).toBeNull();
   });
});

describe('caching', () => {
   it('serves a cached page without touching the database for URLs', async () => {
      mockCount.mockResolvedValue(1);
      mockCacheGetJson.mockResolvedValue('<cached/>');

      expect(await SitemapService.page(1)).toBe('<cached/>');
      expect(mockFindMany).not.toHaveBeenCalled();
      expect(mockCacheSetJson).not.toHaveBeenCalled();
   });

   it('stores generated output for one hour', async () => {
      mockCount.mockResolvedValue(1);

      await SitemapService.page(1);

      expect(SITEMAP_CACHE_TTL_SECONDS).toBe(3600);
      expect(mockCacheSetJson).toHaveBeenCalledWith(
         'sitemap:v1:page:1',
         expect.stringContaining('<urlset'),
         3600
      );
   });

   it('caches the index for one hour and serves it from cache', async () => {
      await SitemapService.index();
      expect(mockCacheSetJson).toHaveBeenCalledWith(
         'sitemap:v1:index',
         expect.stringContaining('<sitemapindex'),
         3600
      );

      mockCount.mockClear();
      mockCacheGetJson.mockResolvedValue('<cached-index/>');
      expect(await SitemapService.index()).toBe('<cached-index/>');
      expect(mockCount).not.toHaveBeenCalled();
   });
});

describe('robots.txt', () => {
   it('points at the sitemap index and disallows API paths', () => {
      const robots = SitemapService.robots();
      expect(robots).toContain('User-agent: *');
      expect(robots).toContain('Disallow: /api/');
      expect(robots).toContain('Disallow: /internal/');
      expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
      expect(renderRobotsTxt('https://x.test')).toContain(
         'Sitemap: https://x.test/sitemap.xml'
      );
   });
});

describe('rendering helpers', () => {
   it('escapes the five XML special characters', () => {
      expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
   });

   it('renders well-formed empty documents', () => {
      expect(renderUrlSet([])).toContain('<urlset');
      expect(renderSitemapIndex([])).toContain('<sitemapindex');
   });
});
