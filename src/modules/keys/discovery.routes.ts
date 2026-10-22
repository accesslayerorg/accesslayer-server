// src/modules/keys/discovery.routes.ts
//
// Marketplace home-page discovery feed: trending, new launches, graduating soon.
// Mounted at /discovery in modules/index.ts.

import { Router } from 'express';
import { z } from 'zod';
import {
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { getTrending, getNewKeys, getGraduating, getSpotlight } from './discovery.service';
import { getSpotlightBidTotals, getSpotlightBids } from '../indexer/spotlight-bid-indexer.service';

const router = Router();

const limitSchema = z.object({
   limit: z.coerce
      .number()
      .int()
      .min(1, 'limit must be at least 1')
      .max(100, 'limit must be at most 100')
      .default(20),
});

/**
 * GET /discovery/trending?limit=
 *
 * Returns the top creator keys by 24 h trade volume, each annotated with a
 * velocity badge (hot / rising / active) reflecting their share of the
 * session's aggregate volume.  Results are cached for 5 minutes and busted
 * immediately on any new trade event or key deployment.
 */
router.get('/trending', async (req, res, next) => {
   const parsed = limitSchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }
   try {
      sendSuccess(res, await getTrending(parsed.data.limit));
   } catch (error) {
      next(error);
   }
});

/**
 * GET /discovery/new?limit=
 *
 * Returns creator keys deployed (registered in the DB) within the last 7 days,
 * newest first.  Results are cached for 5 minutes and busted immediately on
 * any new key deployment.
 */
router.get('/new', async (req, res, next) => {
   const parsed = limitSchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }
   try {
      sendSuccess(res, await getNewKeys(parsed.data.limit));
   } catch (error) {
      next(error);
   }
});

/**
 * GET /discovery/graduating?limit=
 *
 * Returns active creator keys whose circulating supply is within 10 % of their
 * final supply milestone (supplyCap or the highest curveMilestones tier),
 * ordered by proximity to graduation.  Results are cached for 5 minutes and
 * busted on any trade event or new key deployment.
 */
router.get('/graduating', async (req, res, next) => {
   const parsed = limitSchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }
   try {
      sendSuccess(res, await getGraduating(parsed.data.limit));
   } catch (error) {
      next(error);
   }
});

/**
 * GET /discovery/spotlight
 *
 * Returns the currently spotlighted key details, end time, and winning bid.
 * Computes time_remaining_seconds at request time.
 * Returns null with no_spotlight flag when no active spotlight exists.
 */
router.get('/spotlight', async (_req, res, next) => {
   try {
      sendSuccess(res, await getSpotlight());
   } catch (error) {
      next(error);
   }
});

router.get('/spotlight/:keyId/bids', async (req, res, next) => {
   const parsed = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().min(0).default(0),
   }).safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(res, 'Invalid pagination parameters', zodIssuesToDetails(parsed.error.issues));
      return;
   }
   try {
      const [items, totals] = await Promise.all([
         getSpotlightBids(req.params.keyId, parsed.data.limit, parsed.data.offset),
         getSpotlightBidTotals(req.params.keyId),
      ]);
      sendSuccess(res, { items, ...totals, limit: parsed.data.limit, offset: parsed.data.offset });
   } catch (error) { next(error); }
});

export default router;
