// src/modules/sitemap/sitemap.routes.test.ts
jest.mock('./sitemap.service', () => {
   const actual = jest.requireActual('./sitemap.service');
   return {
      ...actual,
      SitemapService: {
         index: jest.fn(),
         page: jest.fn(),
         robots: jest.fn(() => 'User-agent: *\nDisallow: /api/\n'),
      },
   };
});

import express from 'express';
import request from 'supertest';
import sitemapRouter from './sitemap.routes';
import {
   renderSitemapIndex,
   renderUrlSet,
   SITEMAP_PAGE_SIZE,
   SitemapService,
} from './sitemap.service';

const mockService = SitemapService as jest.Mocked<typeof SitemapService>;

const app = express();
app.use(sitemapRouter);

beforeEach(() => jest.clearAllMocks());

/**
 * Structural check against the sitemaps.org 0.9 rules we rely on: namespace,
 * element names, <loc> present and <= 2048 chars, W3C-datetime <lastmod>,
 * and no more than 10,000 entries. (Not a full XSD validation.)
 */
function assertValidSitemapXml(xml: string, root: 'urlset' | 'sitemapindex') {
   const item = root === 'urlset' ? 'url' : 'sitemap';
   expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
   expect(xml).toContain(
      `<${root} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`
   );
   expect(xml.trimEnd().endsWith(`</${root}>`)).toBe(true);

   const items = xml.match(new RegExp(`<${item}>[\\s\\S]*?</${item}>`, 'g')) ?? [];
   expect(items.length).toBeLessThanOrEqual(SITEMAP_PAGE_SIZE);
   for (const entry of items) {
      const loc = /<loc>([^<]+)<\/loc>/.exec(entry);
      expect(loc).not.toBeNull();
      expect((loc as RegExpExecArray)[1].length).toBeLessThanOrEqual(2048);
      expect((loc as RegExpExecArray)[1]).toMatch(/^https?:\/\//);
      const lastmod = /<lastmod>([^<]+)<\/lastmod>/.exec(entry);
      if (lastmod) {
         expect(lastmod[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      }
   }
   // Tag balance: every opened element is closed.
   expect((xml.match(/<(?!\/|\?)[a-z]+[^>]*[^/]>/g) ?? []).length).toBe(
      (xml.match(/<\/[a-z]+>/g) ?? []).length
   );
   return items.length;
}

describe('GET /sitemap.xml', () => {
   it('serves a valid sitemap index as XML', async () => {
      mockService.index.mockResolvedValue(
         renderSitemapIndex([
            { loc: 'https://accesslayer.example/sitemaps/creators-1.xml' },
            { loc: 'https://accesslayer.example/sitemaps/creators-2.xml' },
         ])
      );

      const res = await request(app).get('/sitemap.xml');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/xml/);
      expect(assertValidSitemapXml(res.text, 'sitemapindex')).toBe(2);
   });
});

describe('GET /sitemaps/creators-:page.xml', () => {
   it('serves a valid urlset', async () => {
      mockService.page.mockResolvedValue(
         renderUrlSet([
            {
               loc: 'https://accesslayer.example/creators/alice',
               lastmod: new Date('2026-11-01T10:00:00.000Z'),
            },
         ])
      );

      const res = await request(app).get('/sitemaps/creators-1.xml');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/xml/);
      expect(mockService.page).toHaveBeenCalledWith(1);
      expect(assertValidSitemapXml(res.text, 'urlset')).toBe(1);
   });

   it('returns 404 for a page past the end', async () => {
      mockService.page.mockResolvedValue(null);
      expect((await request(app).get('/sitemaps/creators-99.xml')).status).toBe(404);
   });

   it.each(['creators-0.xml', 'creators-abc.xml', 'creators-1.txt', 'other-1.xml'])(
      'returns 404 for malformed file name %s without hitting the service',
      async file => {
         const res = await request(app).get(`/sitemaps/${file}`);
         expect(res.status).toBe(404);
         expect(mockService.page).not.toHaveBeenCalled();
      }
   );
});

describe('GET /robots.txt', () => {
   it('serves plain text', async () => {
      const res = await request(app).get('/robots.txt');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toContain('Disallow: /api/');
   });
});
