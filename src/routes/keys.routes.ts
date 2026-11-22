import { NextFunction, Request, Response, Router } from 'express';
import {
   DEFAULT_RELATED_KEYS_LIMIT,
   MAX_RELATED_KEYS_LIMIT,
   RelatedKeysService,
} from '../services/related-keys.service';
import {
   getPriceCeilingStatus,
   KeyNotFoundError,
} from '../modules/keys/price-ceiling.service';
import {
   sendNotFound,
   sendSuccess,
   sendValidationError,
} from '../utils/api-response.utils';

export function parseRelatedKeysLimit(raw: unknown): number | null {
   if (raw === undefined || raw === null || raw === '') {
      return DEFAULT_RELATED_KEYS_LIMIT;
   }
   if (Array.isArray(raw) || typeof raw === 'object') return null;

   const text = String(raw).trim();
   if (!/^\d+$/.test(text)) return null;

   const value = Number(text);
   if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_RELATED_KEYS_LIMIT
   ) {
      return null;
   }
   return value;
}

function readKeyId(value: unknown): string | null {
   const raw = Array.isArray(value) ? value[0] : value;
   if (typeof raw !== 'string') return null;
   const keyId = raw.trim();
   return keyId.length > 0 ? keyId : null;
}

export const relatedKeysHandler = async (
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> => {
   try {
      const keyId = readKeyId(req.params.keyId);
      if (!keyId) {
         sendValidationError(res, 'Invalid key parameter', [
            { field: 'keyId', message: 'keyId is required' },
         ]);
         return;
      }

      const limit = parseRelatedKeysLimit(req.query.limit);
      if (limit === null) {
         sendValidationError(res, 'Invalid limit parameter', [
            {
               field: 'limit',
               message: `limit must be an integer between 1 and ${MAX_RELATED_KEYS_LIMIT}`,
            },
         ]);
         return;
      }

      const results = await RelatedKeysService.find(keyId, limit);
      sendSuccess(res, results);
   } catch (error) {
      next(error);
   }
};

export const priceCeilingHandler = async (
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> => {
   try {
      const keyId = readKeyId(req.params.keyId);
      if (!keyId) {
         sendValidationError(res, 'Invalid key parameter', [
            { field: 'keyId', message: 'keyId is required' },
         ]);
         return;
      }

      const status = await getPriceCeilingStatus(keyId);
      sendSuccess(res, status, 200, 'Price ceiling retrieved successfully');
   } catch (error) {
      if (error instanceof KeyNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      next(error);
   }
};

export const relatedKeysRouter = Router();
relatedKeysRouter.get('/:keyId/related', relatedKeysHandler);
relatedKeysRouter.get('/:keyId/ceiling', priceCeilingHandler);

export const v1RelatedKeysRouter = Router();
v1RelatedKeysRouter.get('/keys/:keyId/related', relatedKeysHandler);
v1RelatedKeysRouter.get('/keys/:keyId/ceiling', priceCeilingHandler);

const router = Router();
router.use(relatedKeysRouter);
router.use(v1RelatedKeysRouter);

export default router;
