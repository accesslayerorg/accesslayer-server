// src/modules/search/search.routes.ts
import { Router } from 'express';
import {
   httpSearch,
   httpSearchCreators,
   httpSearchKeys,
} from './search.controllers';

const searchRouter = Router();

/**
 * GET /api/v1/search?q=
 * Grouped overlay results: keys (top 3), creators (top 3), transactions (top 1).
 */
searchRouter.get('/', httpSearch);

/**
 * GET /api/v1/search/keys?q=&limit=&cursor=
 * Full key results with cursor pagination.
 */
searchRouter.get('/keys', httpSearchKeys);

/**
 * GET /api/v1/search/creators?q=&limit=&cursor=
 * Full creator results with cursor pagination.
 */
searchRouter.get('/creators', httpSearchCreators);

searchRouter.all('/', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});
searchRouter.all('/keys', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});
searchRouter.all('/creators', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export default searchRouter;
