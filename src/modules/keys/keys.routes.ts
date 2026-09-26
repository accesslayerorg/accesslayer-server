// src/modules/keys/keys.routes.ts
import { Router } from 'express';
import { z } from 'zod';
import {
   sendError,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   sendForbidden,
   sendConflict,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import {
   getKeyPriceHistory,
   getKeyPriceSnapshots,
   PRICE_HISTORY_INTERVALS,
} from './key-price-history.service';
import { getKeyFees, KeyNotFoundError } from './key-fees.service';
import { getKeyLpStats, getKeyLpHistory } from './key-lp.service';
import {
   getOraclePrice,
   KeyNotFoundError as OracleKeyNotFoundError,
   OraclePriceNotFoundError,
} from './oracle-price.service';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { envConfig } from '../../config';
import { getKeyProposals, getProposalForVoting } from './key-proposals.service';
import { getKeySupply } from './key-supply.service';

import { KeySearchQueryTooShortError, searchKeys } from './key-search.service';
import { KEY_SEARCH_MIN_QUERY_LENGTH } from '../../constants/notifications.constants';
import dividendRouter from '../dividends/dividend.routes';
import whitelistRouter from '../whitelist/whitelist.routes';
import {
   requireJwtAuth,
   AuthenticatedRequest,
} from '../../middlewares/jwt-auth.middleware';
import {
   adminGuard,
   AdminRequest,
} from '../../middlewares/admin-guard.middleware';
import { requireInternalApiKey } from '../../middlewares/internal-auth.middleware';
import {
   registerKeyContract,
   DuplicateKeyRegistrationError,
   InvalidOnChainContractError,
} from './key-registration.service';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { invalidateCreatorDashboardCache } from '../creator/creator-dashboard.service';
import {
   creatorProfileExists,
   getCreatorProfile,
} from '../creator/creator-profile.service';

import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { fetchCreatorProfilesByIds } from '../../utils/creator-batch.utils';
import {
   castKeyProposalVote,
   HolderNotEligibleError,
   DuplicateVoteError,
   OptionIndexOutOfRangeError,
} from './key-proposal-votes.service';
import {
   BuybackPriceNotSetError,
   BuybackWindowClosedError,
   deprecateKey,
   InsufficientPositionError,
   KeyAlreadyDeprecatedError,
   KeyNotDeprecatedError,
   MultisigVerificationError,
   processBuyback,
} from './key-deprecation.service';
import { getKeyCooldown } from './key-cooldown.service';
import { getKeyHoldingCapacity } from './key-holding-capacity.service';
import { StellarAddressSchema } from '../wallet/wallet.schemas';
import {
   freezePosition,
   getFreezeStatus,
   PositionAlreadyFrozenError,
   PositionNotFrozenError,
   PositionNotFoundError,
   unfreezePosition,
} from './key-freeze.service';
import {
   getPriceImpact,
   KeyNotFoundError as PriceImpactKeyNotFoundError,
} from './key-price-impact.service';
import {
   getBuybackPoolBalance,
   getBuybackPoolHistory,
   executeBuybackFromPool,
   KeyNotFoundError as BuybackPoolKeyNotFoundError,
} from './buyback-pool.service';
import {
   getMultiplierTiers,
   matchTierForLockPeriod,
   calculateEffectiveWeight,
} from '../staking/staking.service';

const priceHistoryQuerySchema = z.object({
   from: z.string().datetime(),
   to: z.string().datetime(),
   // Optional (#893): when omitted, the endpoint returns every raw price
   // snapshot in range (price, supply, direction, timestamp) — the shape
   // TWAP calculations need. When provided, it keeps the legacy
   // fixed-bucket downsampled series for chart consumers.
   interval: z.enum(PRICE_HISTORY_INTERVALS).optional(),
});

const searchQuerySchema = z.object({
   q: z.string(),
});

const batchKeysBodySchema = z.object({
   ids: z.array(z.string()).min(1, 'Empty array').max(20, 'More than 20 IDs'),
});

const walletQuerySchema = z.object({
   wallet: StellarAddressSchema,
});

const lpHistoryQuerySchema = z.object({
   limit: z.coerce.number().int().positive().max(100).optional().default(20),
   cursor: z.string().min(1).optional(),
});

const priceImpactQuerySchema = z.object({
   quantity: z.string().transform(v => {
      const num = parseInt(v, 10);
      if (isNaN(num) || num <= 0) {
         throw new Error('Quantity must be a positive integer');
      }
      return num;
   }),
   direction: z.enum(['buy', 'sell']),
});

const buybackPoolHistoryQuerySchema = z.object({
   limit: z
      .string()
      .transform(v => {
         const num = parseInt(v, 10);
         if (isNaN(num) || num < 1 || num > 100) {
            throw new Error('Limit must be between 1 and 100');
         }
         return num;
      })
      .optional(),
   cursor: z.string().optional(),
});

const buybackExecuteBodySchema = z.object({
   amountXlm: z
      .string()
      .refine(
         v => !isNaN(parseFloat(v)) && parseFloat(v) > 0,
         'amountXlm must be a positive number'
      ),
});

const router = Router();

const registerKeyBodySchema = z.preprocess(
   (val: any) => {
      if (val && typeof val === 'object') {
         return {
            keyAddress: val.keyAddress ?? val.key_address,
            creatorWallet: val.creatorWallet ?? val.creator_wallet,
            handle: val.handle,
            displayName: val.displayName ?? val.display_name,
            metadata: val.metadata ?? val.config_metadata ?? val.configMetadata,
         };
      }
      return val;
   },
   z.object({
      keyAddress: z.string().min(1, 'keyAddress is required'),
      creatorWallet: z.string().min(1, 'creatorWallet is required'),
      handle: z.string().optional(),
      displayName: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
   })
);

/**
 * POST /api/v1/keys/register
 * Receives newly deployed creator key contract addresses from factory indexer
 * and registers them in the database for API serving.
 * Restricted to internal indexer service via API key auth.
 */
router.post('/register', requireInternalApiKey, async (req, res, next) => {
   const parsed = registerKeyBodySchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid registration request body',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const registered = await registerKeyContract(parsed.data);
      sendSuccess(res, registered, 201, 'Key contract registered successfully');
   } catch (error) {
      if (error instanceof DuplicateKeyRegistrationError) {
         sendConflict(res, error.message);
         return;
      }
      if (error instanceof InvalidOnChainContractError) {
         sendValidationError(res, error.message);
         return;
      }
      next(error);
   }
});

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
 * GET /api/v1/keys/:keyId/oracle-price
 *
 * Returns the current oracle price (synced from OraclePriceUpdated contract
 * events), the bonding-curve spot price, the deviation percentage, and a
 * staleness flag when the oracle feed has not been updated within
 * ORACLE_STALENESS_THRESHOLD_MS.
 *
 * Response is cached in Redis for ORACLE_CACHE_TTL_MS to match the expected
 * oracle update frequency without hammering the database.
 *
 * 404 is returned when either the key or the oracle price row does not exist.
 */
router.get(
   '/:keyId/oracle-price',
   cacheControl({
      maxAge: Math.floor(envConfig.ORACLE_CACHE_TTL_MS / 1000),
      type: 'public',
      mustRevalidate: true,
   }),
   async (req, res, next) => {
      const keyId = String(req.params.keyId);
      const cacheKey = `oracle-price:${keyId}`;
      try {
         const cached =
            await cacheGetJson<
               ReturnType<typeof getOraclePrice> extends Promise<infer T>
                  ? T
                  : never
            >(cacheKey);
         if (cached !== null) {
            return sendSuccess(res, cached);
         }

         const result = await getOraclePrice(keyId);

         // Cache for ORACLE_CACHE_TTL_MS (converted to whole seconds).
         const ttlSeconds = Math.max(
            1,
            Math.floor(envConfig.ORACLE_CACHE_TTL_MS / 1000)
         );
         await cacheSetJson(cacheKey, result, ttlSeconds);

         sendSuccess(res, result);
      } catch (error) {
         if (
            error instanceof OracleKeyNotFoundError ||
            error instanceof OraclePriceNotFoundError
         ) {
            sendNotFound(
               res,
               error instanceof OraclePriceNotFoundError
                  ? 'Oracle price'
                  : 'Key'
            );
            return;
         }
         next(error);
      }
   }
);

/**
 * GET /api/v1/keys/:keyId
 * Public key detail response includes supply milestone metadata.
 */
router.get('/:keyId', async (req, res, next) => {
   try {
      const keyId = String(req.params.keyId);
      if (!(await creatorProfileExists(keyId))) {
         return sendNotFound(res, 'Key');
      }
      const profile = await getCreatorProfile(keyId);
      sendSuccess(res, profile, 200, 'Key retrieved successfully');
   } catch (error) {
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
 * GET /api/v1/keys/:keyId/lp-stats
 * Total LP contributed and current LP balance for a key, sourced from
 * LPAllocationSent contract events. Cached 60s (#943).
 */
router.get('/:keyId/lp-stats', async (req, res, next) => {
   try {
      sendSuccess(res, await getKeyLpStats(String(req.params.keyId)));
   } catch (error) {
      if (error instanceof KeyNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      next(error);
   }
});

/**
 * GET /api/v1/keys/:keyId/lp-history?limit=&cursor=
 * Paginated LP contribution history for a key, newest first (#943).
 */
router.get('/:keyId/lp-history', async (req, res, next) => {
   const parsed = lpHistoryQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid pagination query',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }
   try {
      sendSuccess(
         res,
         await getKeyLpHistory({
            keyId: String(req.params.keyId),
            ...parsed.data,
         })
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
 * POST /api/v1/keys/:keyId/proposals/:proposalId/vote
 * Cast a governance vote on a proposal by a key holder.
 *
 * - Requires a valid JWT (holder wallet from the token)
 * - Accepts optionIndex in the request body, validated within option range
 * - Returns 409 if the wallet has already voted
 * - Returns 404 if the proposal does not exist or is already closed
 * - Returns 422 if optionIndex is out of range
 * - Returns 403 if the JWT wallet holds no keys (non-holder)
 */
const voteBodySchema = z.object({
   optionIndex: z.number().int().nonnegative(),
});

router.post(
   '/:keyId/proposals/:proposalId/vote',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const keyId = String(req.params.keyId);
         const proposalId = String(req.params.proposalId);
         const wallet = req.user!.wallet;

         const parsed = voteBodySchema.safeParse(req.body);
         if (!parsed.success) {
            sendValidationError(
               res,
               'Invalid request body',
               zodIssuesToDetails(parsed.error.issues)
            );
            return;
         }

         const { optionIndex } = parsed.data;

         const check = await getProposalForVoting(keyId, proposalId);
         if (!check.exists) {
            sendNotFound(res, 'Proposal');
            return;
         }
         if (check.status !== 'active') {
            sendNotFound(res, 'Proposal');
            return;
         }

         if (optionIndex >= (check.options ?? []).length) {
            sendError(
               res,
               422,
               ErrorCode.UNPROCESSABLE_ENTITY,
               `optionIndex ${optionIndex} is out of range`
            );
            return;
         }

         const result = await castKeyProposalVote(
            keyId,
            proposalId,
            optionIndex,
            wallet
         );

         sendSuccess(res, result, 200);
      } catch (error) {
         if (error instanceof HolderNotEligibleError) {
            sendForbidden(res, error.message);
            return;
         }
         if (error instanceof DuplicateVoteError) {
            sendConflict(res, error.message);
            return;
         }
         if (error instanceof OptionIndexOutOfRangeError) {
            sendError(res, 422, ErrorCode.UNPROCESSABLE_ENTITY, error.message);
            return;
         }
         logger.error(
            { error, keyId: req.params.keyId },
            'Key proposal vote failed'
         );
         next(error);
      }
   }
);

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

/**
 * GET /api/v1/keys/:keyId/price-impact?quantity=&direction=buy|sell
 * Calculate price impact of a given trade quantity and direction.
 * Used for frontend warnings and pre-trade validation.
 * Response cached with 10s TTL per key.
 * No auth required as a read-only check.
 */
router.get('/:keyId/price-impact', async (req, res, next) => {
   const parsed = priceImpactQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid price-impact query',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const { quantity, direction } = parsed.data;
      const priceImpact = await getPriceImpact(
         req.params.keyId,
         quantity,
         direction
      );
      sendSuccess(res, priceImpact);
   } catch (error) {
      if (error instanceof PriceImpactKeyNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      if (error instanceof Error) {
         sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
         return;
      }
      logger.error(
         { error, keyId: req.params.keyId },
         'Price impact calculation failed'
      );
      next(error);
   }
});

/**
 * GET /api/v1/keys/:keyId/buyback-pool
 * Get current buyback pool balance for a creator key.
 * Synced from SellTaxCollected contract events.
 * Cached with 30s TTL.
 * No auth required.
 */
router.get('/:keyId/buyback-pool', async (req, res, next) => {
   try {
      const poolBalance = await getBuybackPoolBalance(req.params.keyId);
      sendSuccess(res, poolBalance);
   } catch (error) {
      if (error instanceof BuybackPoolKeyNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      logger.error(
         { error, keyId: req.params.keyId },
         'Buyback pool fetch failed'
      );
      next(error);
   }
});

/**
 * GET /api/v1/keys/:keyId/buyback-pool/history?limit=&cursor=
 * Get paginated history of buyback pool contributions.
 * Returns contributions in reverse chronological order.
 * Uses cursor-based pagination.
 * No auth required.
 */
router.get('/:keyId/buyback-pool/history', async (req, res, next) => {
   const parsed = buybackPoolHistoryQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid buyback pool history query',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const { limit, cursor } = parsed.data;
      const history = await getBuybackPoolHistory(
         req.params.keyId,
         limit,
         cursor
      );
      sendSuccess(res, history);
   } catch (error) {
      if (error instanceof BuybackPoolKeyNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      logger.error(
         { error, keyId: req.params.keyId },
         'Buyback pool history fetch failed'
      );
      next(error);
   }
});

/**
 * POST /api/v1/keys/:keyId/buyback-pool/execute
 * Admin endpoint to trigger manual buyback from pool.
 * Restricted to admin role.
 * Creates an execution record for on-chain processing.
 */
router.post(
   '/:keyId/buyback-pool/execute',
   requireJwtAuth,
   adminGuard,
   async (req, res, next) => {
      const parsed = buybackExecuteBodySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid buyback execute request',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const { amountXlm } = parsed.data;
         const { Decimal } = await import('@prisma/client/runtime/library');
         const keyId = Array.isArray(req.params.keyId)
            ? req.params.keyId[0]
            : req.params.keyId;
         const result = await executeBuybackFromPool(
            keyId,
            new Decimal(amountXlm),
            (req as AdminRequest).adminId || ''
         );
         sendSuccess(res, result, 202, 'Buyback execution initiated');
      } catch (error) {
         if (error instanceof BuybackPoolKeyNotFoundError) {
            sendNotFound(res, 'Key');
            return;
         }
         if (error instanceof Error) {
            sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
            return;
         }
         logger.error(
            { error, keyId: req.params.keyId },
            'Buyback execution failed'
         );
         next(error);
      }
   }
);

/**
 * GET /api/v1/keys/:keyId/freeze-status?wallet=
 * Frozen and liquid balance for a holder on a key.
 */
router.get('/:keyId/freeze-status', async (req, res, next) => {
   const parsed = walletQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }
   try {
      sendSuccess(
         res,
         await getFreezeStatus(String(req.params.keyId), parsed.data.wallet)
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
 * GET /api/v1/keys/:keyId/cooldown?wallet=
 * Remaining buy cooldown for a wallet on a key.
 */
router.get('/:keyId/cooldown', async (req, res, next) => {
   const parsed = walletQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }
   try {
      sendSuccess(
         res,
         await getKeyCooldown(String(req.params.keyId), parsed.data.wallet)
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
 * GET /api/v1/keys/:keyId/price-history?from=&to=[&interval=1h|24h|7d]
 *
 * Returns price snapshots recorded for a key within [from, to], indexed on
 * (creatorId, recordedAt) for fast range scans (#893).
 *
 * - Without `interval`: every raw snapshot in range — price, post-trade
 *   supply, and trade direction — ordered oldest first. This is the input
 *   TWAP calculations need.
 * - With `interval`: a downsampled, chart-friendly series (legacy shape).
 */

/**
 * GET /api/v1/keys/:keyId/holding-capacity?wallet=
 * Wallet holding, holder cap, and remaining purchase capacity on a key.
 */
router.get('/:keyId/holding-capacity', async (req, res, next) => {
   const parsed = walletQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }
   try {
      sendSuccess(
         res,
         await getKeyHoldingCapacity(
            String(req.params.keyId),
            parsed.data.wallet
         )
      );
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
      if (parsed.data.interval) {
         sendSuccess(
            res,
            await getKeyPriceHistory(
               req.params.keyId,
               from,
               to,
               parsed.data.interval
            )
         );
         return;
      }

      const snapshots = await getKeyPriceSnapshots(req.params.keyId, from, to);
      sendSuccess(
         res,
         snapshots.map(snapshot => ({
            timestamp: snapshot.timestamp,
            price: snapshot.price.toString(),
            supply: snapshot.supply.toString(),
            direction: snapshot.direction,
         }))
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

// ── POST /:keyId/deprecate ───────────────────────────────────
// Admin endpoint: deprecate a key with a guaranteed holder buyback price.
// Requires a 2-of-3 admin multisig (Ed25519 signatures over the canonical
// deprecation message). Notifies all holders via the notification feed.

const buybackPriceSchema = z
   .union([z.string(), z.number()])
   .transform(value => String(value))
   .refine(
      value => {
         const parsed = Number(value);
         return Number.isFinite(parsed) && parsed > 0;
      },
      { message: 'buybackPriceXlm must be a positive number' }
   );

const deprecateBodySchema = z.object({
   buybackPriceXlm: buybackPriceSchema,
   buybackExpiresAt: z.string().datetime({
      message: 'buybackExpiresAt must be an ISO-8601 datetime string',
   }),
   signatures: z
      .array(
         z.object({
            wallet: z
               .string()
               .regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar admin wallet'),
            signature: z.string().min(1, 'signature is required'),
         })
      )
      .min(2, 'Deprecation requires at least 2 admin signatures')
      .max(3, 'At most 3 admin signatures are accepted'),
});

/**
 * POST /api/v1/keys/:keyId/deprecate
 *
 * Sets the deprecation flag, guaranteed buyback price, and buyback expiry on
 * the key record. Requires admin JWT + 2-of-3 multisig signatures. All
 * current holders are notified through the key_deprecated notification.
 */
router.post(
   '/:keyId/deprecate',
   adminGuard,
   async (req: AdminRequest, res, next) => {
      try {
         const keyId = String(req.params.keyId);
         const actor = req.adminId || 'unknown';

         const parsed = deprecateBodySchema.safeParse(req.body);
         if (!parsed.success) {
            sendValidationError(
               res,
               'Invalid deprecate request body',
               zodIssuesToDetails(parsed.error.issues)
            );
            return;
         }

         const buybackExpiresAt = new Date(parsed.data.buybackExpiresAt);
         if (buybackExpiresAt.getTime() <= Date.now()) {
            sendError(
               res,
               400,
               ErrorCode.BAD_REQUEST,
               'buybackExpiresAt must be in the future'
            );
            return;
         }

         const result = await deprecateKey({
            keyId,
            buybackPriceXlm: parsed.data.buybackPriceXlm,
            buybackExpiresAt,
            signatures: parsed.data.signatures,
            actor,
         });
         sendSuccess(res, result, 201);
      } catch (error) {
         if (error instanceof KeyNotFoundError) {
            sendNotFound(res, 'Key');
            return;
         }
         if (error instanceof KeyAlreadyDeprecatedError) {
            sendConflict(res, error.message);
            return;
         }
         if (error instanceof MultisigVerificationError) {
            sendForbidden(res, error.message);
            return;
         }
         logger.error(
            { error, keyId: req.params.keyId },
            'Key deprecate failed'
         );
         next(error);
      }
   }
);

router.all('/:keyId/deprecate', (_req, res) => {
   res.set('Allow', 'POST').sendStatus(405);
});

// ── POST /:keyId/buyback ─────────────────────────────────────
// Holder exit at the guaranteed buyback price on a deprecated key.
// Rejected with 410 Gone after the buyback window expires.

/**
 * POST /api/v1/keys/:keyId/buyback
 *
 * Processes the authenticated holder's full-position buyback atomically:
 * zeroes the balance, decrements circulating supply, and writes the payment
 * record in a single transaction.
 */
router.post(
   '/:keyId/buyback',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const keyId = String(req.params.keyId);
         const wallet = req.user!.wallet;
         const result = await processBuyback(keyId, wallet);
         await invalidateCreatorDashboardCache(result.keyId);
         sendSuccess(res, result, 201);
      } catch (error) {
         if (error instanceof KeyNotFoundError) {
            sendNotFound(res, 'Key');
            return;
         }
         if (error instanceof KeyNotDeprecatedError) {
            sendConflict(res, error.message);
            return;
         }
         if (error instanceof BuybackWindowClosedError) {
            sendError(res, 410, ErrorCode.GONE, error.message);
            return;
         }
         if (
            error instanceof BuybackPriceNotSetError ||
            error instanceof InsufficientPositionError
         ) {
            sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
            return;
         }
         logger.error({ error, keyId: req.params.keyId }, 'Key buyback failed');
         next(error);
      }
   }
);

router.all('/:keyId/buyback', (_req, res) => {
   res.set('Allow', 'POST').sendStatus(405);
});

// ── GET /:keyId/positions ─────────────────────────────────────
// Returns the authenticated wallet's position for a key, including freeze
// status (is_frozen / frozen_at). Requires a valid JWT.

/**
 * GET /api/v1/keys/:keyId/positions
 *
 * Returns the calling wallet's position on the given key including
 * balance, cost basis, lockup expiry, and freeze status (#894).
 */
router.get(
   '/:keyId/positions',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const keyId = String(req.params.keyId);
         const wallet = req.user!.wallet;

         const creator = await prisma.creatorProfile.findFirst({
            where: { OR: [{ id: keyId }, { handle: keyId }] },
            select: { id: true },
         });
         if (!creator) {
            sendNotFound(res, 'Key');
            return;
         }

         const ownership = await prisma.keyOwnership.findUnique({
            where: {
               ownerAddress_creatorId: {
                  ownerAddress: wallet,
                  creatorId: creator.id,
               },
            },
            select: {
               id: true,
               ownerAddress: true,
               creatorId: true,
               balance: true,
               costBasis: true,
               lastBuyAt: true,
               lockupExpiresAt: true,
               frozen: true,
               frozenAt: true,
               createdAt: true,
               updatedAt: true,
            },
         });

         if (!ownership) {
            sendNotFound(res, 'Key position');
            return;
         }

         const tiers = await getMultiplierTiers();
         let lockPeriodSeconds = 0;
         if (ownership.lockupExpiresAt) {
            const startTime = ownership.lastBuyAt ?? ownership.createdAt;
            const diffMs =
               ownership.lockupExpiresAt.getTime() - startTime.getTime();
            lockPeriodSeconds = Math.max(0, Math.round(diffMs / 1000));
         }
         const matchedTier = matchTierForLockPeriod(lockPeriodSeconds, tiers);
         const effectiveWeight = calculateEffectiveWeight(
            ownership.balance.toString(),
            matchedTier.multiplier
         );

         sendSuccess(res, {
            id: ownership.id,
            ownerAddress: ownership.ownerAddress,
            creatorId: ownership.creatorId,
            balance: ownership.balance.toString(),
            costBasis: ownership.costBasis?.toString() ?? '0',
            lastBuyAt: ownership.lastBuyAt ?? null,
            lockupExpiresAt: ownership.lockupExpiresAt ?? null,
            is_frozen: ownership.frozen,
            frozen_at: ownership.frozenAt ?? null,
            tier: matchedTier.tier,
            multiplier: matchedTier.multiplier,
            effectiveWeight,
            tierData: matchedTier,
            createdAt: ownership.createdAt,
            updatedAt: ownership.updatedAt,
         });
      } catch (error) {
         logger.error(
            { error, keyId: req.params.keyId },
            'Get key position failed'
         );
         next(error);
      }
   }
);

router.all('/:keyId/positions', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

// ── POST /:keyId/positions/freeze | /:keyId/positions/unfreeze ──────────────
// Canonical position freeze paths per issue #894. These endpoints are
// functionally identical to /:keyId/freeze and /:keyId/unfreeze but use
// the /positions/ sub-resource path specified in the acceptance criteria.

/**
 * POST /api/v1/keys/:keyId/positions/freeze
 * Freeze the authenticated wallet's position on a key. Audited (#894).
 */
router.post(
   '/:keyId/positions/freeze',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const result = await freezePosition(
            String(req.params.keyId),
            req.user!.wallet
         );
         sendSuccess(res, result, 201);
      } catch (error) {
         if (error instanceof KeyNotFoundError) {
            sendNotFound(res, 'Key');
            return;
         }
         if (error instanceof PositionNotFoundError) {
            sendNotFound(res, 'Key position');
            return;
         }
         if (error instanceof PositionAlreadyFrozenError) {
            sendConflict(res, error.message);
            return;
         }
         logger.error(
            { error, keyId: req.params.keyId },
            'Key position freeze failed'
         );
         next(error);
      }
   }
);

router.all('/:keyId/positions/freeze', (_req, res) => {
   res.set('Allow', 'POST').sendStatus(405);
});

/**
 * POST /api/v1/keys/:keyId/positions/unfreeze
 * Release the freeze and restore trading/transfer ability. Audited (#894).
 */
router.post(
   '/:keyId/positions/unfreeze',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const result = await unfreezePosition(
            String(req.params.keyId),
            req.user!.wallet
         );
         sendSuccess(res, result, 200);
      } catch (error) {
         if (error instanceof KeyNotFoundError) {
            sendNotFound(res, 'Key');
            return;
         }
         if (error instanceof PositionNotFoundError) {
            sendNotFound(res, 'Key position');
            return;
         }
         if (error instanceof PositionNotFrozenError) {
            sendConflict(res, error.message);
            return;
         }
         logger.error(
            { error, keyId: req.params.keyId },
            'Key position unfreeze failed'
         );
         next(error);
      }
   }
);

router.all('/:keyId/positions/unfreeze', (_req, res) => {
   res.set('Allow', 'POST').sendStatus(405);
});

// ── POST /:keyId/freeze | /:keyId/unfreeze ───────────────────
// Self-custody freeze: the holder locks their own position so buys, sells,
// and transfers of it are rejected with 403 until explicitly unfrozen.

/**
 * POST /api/v1/keys/:keyId/freeze
 * Freeze the authenticated wallet's position on a key. Audited.
 */
router.post(
   '/:keyId/freeze',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const result = await freezePosition(
            String(req.params.keyId),
            req.user!.wallet
         );
         sendSuccess(res, result, 201);
      } catch (error) {
         if (error instanceof KeyNotFoundError) {
            sendNotFound(res, 'Key');
            return;
         }
         if (error instanceof PositionNotFoundError) {
            sendNotFound(res, 'Key position');
            return;
         }
         if (error instanceof PositionAlreadyFrozenError) {
            sendConflict(res, error.message);
            return;
         }
         logger.error(
            { error, keyId: req.params.keyId },
            'Key position freeze failed'
         );
         next(error);
      }
   }
);

router.all('/:keyId/freeze', (_req, res) => {
   res.set('Allow', 'POST').sendStatus(405);
});

/**
 * POST /api/v1/keys/:keyId/unfreeze
 * Release the freeze and restore trading/transfer ability. Audited.
 */
router.post(
   '/:keyId/unfreeze',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const result = await unfreezePosition(
            String(req.params.keyId),
            req.user!.wallet
         );
         sendSuccess(res, result, 200);
      } catch (error) {
         if (error instanceof KeyNotFoundError) {
            sendNotFound(res, 'Key');
            return;
         }
         if (error instanceof PositionNotFoundError) {
            sendNotFound(res, 'Key position');
            return;
         }
         if (error instanceof PositionNotFrozenError) {
            sendConflict(res, error.message);
            return;
         }
         logger.error(
            { error, keyId: req.params.keyId },
            'Key position unfreeze failed'
         );
         next(error);
      }
   }
);

router.all('/:keyId/unfreeze', (_req, res) => {
   res.set('Allow', 'POST').sendStatus(405);
});

export default router;
