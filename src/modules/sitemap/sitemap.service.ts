// src/modules/sitemap/sitemap.service.ts
// Server-generated sitemaps and robots.txt for creator pages (#1242).

import { envConfig } from '../../config';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { prisma } from '../../utils/prisma.utils';

/** Maximum URLs per sitemap file (the protocol allows 50,000; we stay lower). */
export const SITEMAP_PAGE_SIZE = 10_000;
/** Generated sitemaps are cached in Redis for one hour. */
export const SITEMAP_CACHE_TTL_SECONDS = 3600;
export const SITEMAP_CACHE_PREFIX = 'sitemap:v1:';

/** Paths crawlers must not index. */
export const ROBOTS_DISALLOWED_PATHS = ['/api/', '/internal/'] as const;

const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

export interface SitemapUrl {
   loc: string;
   lastmod: Date;
}

/** Public site origin without a trailing slash, from `PUBLIC_SITE_URL`. */
export function getPublicOrigin(): string {
   return new URL(envConfig.PUBLIC_SITE_URL).origin;
}

export function escapeXml(value: string): string {
   return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
}

export function renderUrlSet(urls: SitemapUrl[]): string {
   const entries = urls
      .map(
         url =>
            `  <url>\n    <loc>${escapeXml(url.loc)}</loc>\n    <lastmod>${url.lastmod.toISOString()}</lastmod>\n  </url>`
      )
      .join('\n');
   return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${SITEMAP_NS}">\n${entries}${entries ? '\n' : ''}</urlset>\n`;
}

export function renderSitemapIndex(
   entries: Array<{ loc: string; lastmod?: Date }>
): string {
   const body = entries
      .map(
         entry =>
            `  <sitemap>\n    <loc>${escapeXml(entry.loc)}</loc>${
               entry.lastmod
                  ? `\n    <lastmod>${entry.lastmod.toISOString()}</lastmod>`
                  : ''
            }\n  </sitemap>`
      )
      .join('\n');
   return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="${SITEMAP_NS}">\n${body}${body ? '\n' : ''}</sitemapindex>\n`;
}

export function renderRobotsTxt(origin: string = getPublicOrigin()): string {
   const lines = [
      'User-agent: *',
      ...ROBOTS_DISALLOWED_PATHS.map(path => `Disallow: ${path}`),
      '',
      `Sitemap: ${origin}/sitemap.xml`,
      '',
   ];
   return lines.join('\n');
}

/**
 * Keys that must not be advertised to search engines: deprecated or retired
 * (non-Active status), flagged for sunset, or currently frozen.
 */
async function getIndexableWhere(now: Date) {
   const frozen = await prisma.keyFreeze.findMany({
      where: { isFrozen: true },
      select: { keyId: true, expiryTimestamp: true },
   });
   // A freeze whose expiry has passed no longer applies (see freeze.service).
   const frozenIds = frozen
      .filter(f => !f.expiryTimestamp || f.expiryTimestamp > now)
      .map(f => f.keyId);

   return {
      status: 'Active',
      deprecatedAt: null,
      sunsetFlaggedAt: null,
      ...(frozenIds.length > 0 ? { id: { notIn: frozenIds } } : {}),
   };
}

export async function countSitemapPages(now: Date = new Date()): Promise<number> {
   const total = await prisma.creatorProfile.count({
      where: await getIndexableWhere(now),
   });
   return Math.max(1, Math.ceil(total / SITEMAP_PAGE_SIZE));
}

/** URLs for page `n` (1-based); at most `SITEMAP_PAGE_SIZE`. */
export async function getSitemapPageUrls(
   page: number,
   now: Date = new Date()
): Promise<SitemapUrl[]> {
   const origin = getPublicOrigin();
   const rows = await prisma.creatorProfile.findMany({
      where: await getIndexableWhere(now),
      orderBy: { id: 'asc' },
      skip: (page - 1) * SITEMAP_PAGE_SIZE,
      take: SITEMAP_PAGE_SIZE,
      select: { handle: true, updatedAt: true },
   });
   return rows.map(row => ({
      loc: `${origin}/creators/${encodeURIComponent(row.handle)}`,
      lastmod: row.updatedAt,
   }));
}

async function cached(key: string, build: () => Promise<string>): Promise<string> {
   const hit = await cacheGetJson<string>(`${SITEMAP_CACHE_PREFIX}${key}`);
   if (typeof hit === 'string') return hit;
   const xml = await build();
   await cacheSetJson(`${SITEMAP_CACHE_PREFIX}${key}`, xml, SITEMAP_CACHE_TTL_SECONDS);
   return xml;
}

export const SitemapService = {
   /** Sitemap index with one entry per page. */
   index(): Promise<string> {
      return cached('index', async () => {
         const origin = getPublicOrigin();
         const pages = await countSitemapPages();
         return renderSitemapIndex(
            Array.from({ length: pages }, (_, i) => ({
               loc: `${origin}/sitemaps/creators-${i + 1}.xml`,
            }))
         );
      });
   },

   /** Sitemap page `n` (1-based). Returns null when the page does not exist. */
   async page(n: number): Promise<string | null> {
      if (!Number.isInteger(n) || n < 1) return null;
      const pages = await countSitemapPages();
      if (n > pages) return null;
      return cached(`page:${n}`, async () =>
         renderUrlSet(await getSitemapPageUrls(n))
      );
   },

   robots(): string {
      return renderRobotsTxt();
   },
};
