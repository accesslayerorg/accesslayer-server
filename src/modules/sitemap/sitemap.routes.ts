// src/modules/sitemap/sitemap.routes.ts
import { Router } from 'express';
import { SitemapService } from './sitemap.service';

const sitemapRouter = Router();

const PAGE_FILE = /^creators-([1-9]\d{0,8})\.xml$/;
const CACHE_CONTROL = 'public, max-age=3600';

/** GET /sitemap.xml - sitemap index, one entry per sitemap page. */
sitemapRouter.get('/sitemap.xml', async (_req, res, next) => {
   try {
      const xml = await SitemapService.index();
      res.type('application/xml').set('Cache-Control', CACHE_CONTROL).send(xml);
   } catch (error) {
      next(error);
   }
});

/** GET /sitemaps/creators-:page.xml - up to 10,000 creator URLs per file. */
sitemapRouter.get('/sitemaps/:file', async (req, res, next) => {
   try {
      const match = PAGE_FILE.exec(String(req.params.file));
      const xml = match ? await SitemapService.page(Number(match[1])) : null;
      if (xml === null) {
         return res.status(404).type('text/plain').send('Sitemap not found');
      }
      return res
         .type('application/xml')
         .set('Cache-Control', CACHE_CONTROL)
         .send(xml);
   } catch (error) {
      return next(error);
   }
});

/** GET /robots.txt - points crawlers at the sitemap index, hides API paths. */
sitemapRouter.get('/robots.txt', (_req, res) => {
   res
      .type('text/plain')
      .set('Cache-Control', CACHE_CONTROL)
      .send(SitemapService.robots());
});

export default sitemapRouter;
