// src/modules/keys/keys.routes.ts
import { Router } from 'express';
import { z } from 'zod';
import {
   sendError,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import {
   getKeyPriceHistory,
   PRICE_HISTORY_INTERVALS,
} from './key-price-history.service';
import { getKeyFees, KeyNotFoundError } from './key-fees.service';

import { getKeyProposals } from './key-proposals.service';
import { getKeySupply } from './key-supply.service';

import { KeySearchQueryTooShortError, searchKeys } from './key-search.service';
import { KEY_SEARCH_MIN_QUERY_LENGTH } from '../../constants/notifications.constants';
import dividendRouter from '../dividends/dividend.routes';
import whitelistRouter from '../whitelist/whitelist.routes';
import {
   requireJwtAuth,
   AuthenticatedRequest,
} from '../../middlewares/jwt-auth.middleware';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { invalidateCreatorDashboardCache } from '../creator/creator-dashboard.service';

import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { fetchCreatorProfilesByIds } from '../../utils/creator-batch.utils';

const priceHistoryQuerySchema = z.object({
   from: z.string().datetime(),
   to: z.string().datetime(),
   interval: z.enum(PRICE_HISTORY_INTERVALS),
});

const searchQuerySchema = z.object({
   q: z.string(),
});

const batchKeysBodySchema = z.object({
   ids: z.array(z.string()).min(1, 'Empty array').max(20, 'More than 20 IDs'),
});

const router = Router();

/**
 * POST /api/v1/keys/batch
 * Batch key metadata endpoint to fetch details for multiple key IDs in a single request (#813).
 */
router.post('/batch', async (req, res, next) => {
   const parsed = batchKeysBodySchema.safeParse(req.body);
   if (!parsed.success) {
      sendError(
         res,
         400,
         ErrorCode.VALIDATION_ERROR,
         'Invalid batch request body',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   const { ids } = parsed.data;
   try {
      const results: (any | null)[] = [];
      const missingIds: string[] = [];
      const cachedMap = new Map<string, any>();

      for (const id of ids) {
         const cacheKey = `key:metadata:${id}`;
         const cached = await cacheGetJson<any>(cacheKey);
         if (cached !== null) {
            cachedMap.set(id, cached);
         } else {
            missingIds.push(id);
         }
      }

      const dbMap = new Map<string, any>();
      if (missingIds.length > 0) {
         const fetchedProfiles = await fetchCreatorProfilesByIds(missingIds);
         for (let i = 0; i < missingIds.length; i++) {
            const profile = fetchedProfiles[i];
            if (profile) {
               dbMap.set(missingIds[i], profile);
               await cacheSetJson(`key:metadata:${missingIds[i]}`, profile, 60);
            }
         }
      }

      for (const id of ids) {
         if (cachedMap.has(id)) {
            results.push(cachedMap.get(id));
         } else if (dbMap.has(id)) {
            results.push(dbMap.get(id));
         } else {
            results.push(null);
         }
      }

      sendSuccess(res, results);
   } catch (error) {
      next(error);
   }
});

/**
 * GET /api/v1/keys/search?q=
 * Full-text search over creator name and description.
 * Must be registered before /:keyId routes.
 */
router.get('/search', async (req, res, next) => {
   const parsed = searchQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid search query',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   const q = typeof parsed.data.q === 'string' ? parsed.data.q : '';
   if (q.trim().length < KEY_SEARCH_MIN_QUERY_LENGTH) {
      sendError(
         res,
         400,
         ErrorCode.VALIDATION_ERROR,
         `Query must be at least ${KEY_SEARCH_MIN_QUERY_LENGTH} characters`
      );
      return;
   }

   try {
      sendSuccess(res, { items: await searchKeys(q) });
   } catch (error) {
      if (error instanceof KeySearchQueryTooShortError) {
         sendError(res, 400, ErrorCode.VALIDATION_ERROR, error.message);
         return;
      }
      next(error);
   }
});

/**
 * GET /api/v1/keys/:keyId/fees
 * Protocol fee + creator royalty BPS for the buy confirmation modal.
 */
router.get('/:keyId/fees', async (req, res, next) => {
   try {
      sendSuccess(res, await getKeyFees(req.params.keyId));
   } catch (error) {
      if (error instanceof KeyNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      next(error);
   }
});

/**
 * GET /api/v1/keys/:keyId/proposals?status=active|closed
 * List governance proposals for a creator key.
 */
const proposalStatusSchema = z.object({
   status: z.enum(['active', 'closed']).optional(),
});

router.get('/:keyId/proposals', async (req, res, next) => {
   const parsed = proposalStatusSchema.safeParse(req.query);
   if (!parsed.success) {
      sendError(
         res,
         400,
         ErrorCode.VALIDATION_ERROR,
         'Invalid status filter',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }
   try {
      sendSuccess(
         res,
         await getKeyProposals(req.params.keyId, parsed.data.status)
      );
   } catch (error) {
      if (error instanceof KeyNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      next(error);
   }
});

/**
 * GET /api/v1/keys/:keyId/supply
 * Return supply cap, circulating supply, burned supply, and remaining mintable.
 */
router.get('/:keyId/supply', async (req, res, next) => {
   try {
      sendSuccess(res, await getKeySupply(req.params.keyId));
   } catch (error) {
      if (error instanceof KeyNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      next(error);
   }
});

router.get('/:keyId/price-history', async (req, res, next) => {
   const parsed = priceHistoryQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendError(
         res,
         400,
         ErrorCode.VALIDATION_ERROR,
         'Invalid price-history query',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }
   const from = new Date(parsed.data.from);
   const to = new Date(parsed.data.to);
   if (from > to) {
      sendError(
         res,
         400,
         ErrorCode.BAD_REQUEST,
         'from must be before or equal to to'
      );
      return;
   }
   try {
      sendSuccess(
         res,
         await getKeyPriceHistory(
            req.params.keyId,
            from,
            to,
            parsed.data.interval
         )
      );
   } catch (error) {
      next(error);
   }
});

// Mount dividend routes
router.use('/', dividendRouter);

// Mount whitelist routes
router.use('/', whitelistRouter);

// ── POST /:keyId/burn ─────────────────────────────────────────

const burnSchema = z.object({
   quantity: z.number().int().positive(),
});

/**
 * POST /api/v1/keys/:keyId/burn
 *
 * Burn keys held by the authenticated wallet. Validates holder balance,
 * decrements holder balance and circulatingSupply atomically, writes
 * an activity record, and returns updated values.
 */
router.post(
   '/:keyId/burn',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const keyId = String(req.params.keyId);
         const wallet = req.user!.wallet;

         const parsed = burnSchema.safeParse(req.body);
         if (!parsed.success) {
            sendValidationError(
               res,
               'Invalid request body',
               zodIssuesToDetails(parsed.error.issues)
            );
            return;
         }

         const { quantity } = parsed.data;

         const creator = await prisma.creatorProfile.findUnique({
            where: { id: keyId },
            select: { id: true, circulatingSupply: true },
         });
         if (!creator) {
            sendNotFound(res, 'Key');
            return;
         }

         const ownership = await prisma.keyOwnership.findUnique({
            where: {
               ownerAddress_creatorId: {
                  ownerAddress: wallet,
                  creatorId: keyId,
               },
            },
         });

         const balance = ownership ? BigInt(ownership.balance.toString()) : 0n;
         if (balance < BigInt(quantity)) {
            sendError(
               res,
               400,
               ErrorCode.BAD_REQUEST,
               'Insufficient key balance for burn'
            );
            return;
         }

         // TODO: submit burn contract call via Stellar SDK
         // On-chain failure should return 502 before reaching this point.

         const newBalance = balance - BigInt(quantity);
         const currentCirculating = BigInt(
            creator.circulatingSupply.toString()
         );
         const newCirculating = currentCirculating - BigInt(quantity);

         await prisma.$transaction([
            prisma.keyOwnership.update({
               where: {
                  ownerAddress_creatorId: {
                     ownerAddress: wallet,
                     creatorId: keyId,
                  },
               },
               data: { balance: newBalance.toString() },
            }),
            prisma.creatorProfile.update({
               where: { id: keyId },
               data: { circulatingSupply: newCirculating.toString() },
            }),
            prisma.activity.create({
               data: {
                  type: 'KEY_BURNED',
                  actor: wallet,
                  creatorId: keyId,
                  payload: {
                     keyId,
                     quantity,
                     balanceAfter: newBalance.toString(),
                     circulatingSupplyAfter: newCirculating.toString(),
                  },
               },
            }),
         ]);

         await invalidateCreatorDashboardCache(keyId);

         sendSuccess(res, {
            circulatingSupply: newCirculating.toString(),
            balance: newBalance.toString(),
         });
      } catch (error) {
         logger.error({ error, keyId: req.params.keyId }, 'Key burn failed');
         next(error);
      }
   }
);

router.all('/:keyId/burn', (_req, res) => {
   res.set('Allow', 'POST').sendStatus(405);
});

export default router;
