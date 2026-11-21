// src/modules/investor/investor.routes.ts
import { Router } from 'express';
import { z } from 'zod';
import {
  sendSuccess,
  sendNotFound,
  sendValidationError,
  zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
  getInvestorDividends,
} from './dividend.service';
import {
  addToWhitelist,
  removeFromWhitelist,
  getWhitelistAddresses,
  WhitelistNotFoundError,
} from './whitelist.service';

const router = Router();

const dividendsParamsSchema = z.object({
  wallet: z.string().min(1),
});

const dividendsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * GET /api/v1/investor/:wallet/dividends
 * List dividend payouts for an investor wallet with cursor pagination.
 */
router.get('/:wallet/dividends', async (req, res, next) => {
  const params = dividendsParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendValidationError(res, 'Invalid wallet', zodIssuesToDetails(params.error.issues));
    return;
  }
  const query = dividendsQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendValidationError(res, 'Invalid query', zodIssuesToDetails(query.error.issues));
    return;
  }
  try {
    const result = await getInvestorDividends(
      params.data.wallet,
      query.data.cursor,
      query.data.limit
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
});

const whitelistParamsSchema = z.object({
  keyId: z.string().min(1),
});

const whitelistBodySchema = z.object({
  address: z.string().min(1),
});

/**
 * POST /api/v1/investor/:keyId/whitelist/add
 */
router.post('/:keyId/whitelist/add', async (req, res, next) => {
  const params = whitelistParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendValidationError(res, 'Invalid keyId', zodIssuesToDetails(params.error.issues));
    return;
  }
  const body = whitelistBodySchema.safeParse(req.body);
  if (!body.success) {
    sendValidationError(res, 'Invalid body', zodIssuesToDetails(body.error.issues));
    return;
  }
  try {
    const entry = await addToWhitelist(params.data.keyId, body.data.address);
    sendSuccess(res, entry, 201);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/investor/:keyId/whitelist/remove
 */
router.post('/:keyId/whitelist/remove', async (req, res, next) => {
  const params = whitelistParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendValidationError(res, 'Invalid keyId', zodIssuesToDetails(params.error.issues));
    return;
  }
  const body = whitelistBodySchema.safeParse(req.body);
  if (!body.success) {
    sendValidationError(res, 'Invalid body', zodIssuesToDetails(body.error.issues));
    return;
  }
  try {
    await removeFromWhitelist(params.data.keyId, body.data.address);
    sendSuccess(res, { removed: true });
  } catch (error) {
    if (error instanceof WhitelistNotFoundError) {
      sendNotFound(res, 'Whitelist entry');
      return;
    }
    next(error);
  }
});

/**
 * GET /api/v1/investor/:keyId/whitelist/addresses
 */
router.get('/:keyId/whitelist/addresses', async (req, res, next) => {
  const params = whitelistParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendValidationError(res, 'Invalid keyId', zodIssuesToDetails(params.error.issues));
    return;
  }
  try {
    const addresses = await getWhitelistAddresses(params.data.keyId);
    sendSuccess(res, addresses);
  } catch (error) {
    next(error);
  }
});

export default router;
