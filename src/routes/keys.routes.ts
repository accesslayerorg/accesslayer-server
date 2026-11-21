import { NextFunction, Request, Response, Router } from 'express';
import {
   DEFAULT_RELATED_KEYS_LIMIT,
   MAX_RELATED_KEYS_LIMIT,
   RelatedKeysService,
} from '../services/related-keys.service';
import { sendSuccess, sendValidationError } from '../utils/api-response.utils';

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

export const keysRouter = Router();
keysRouter.get('/:keyId/related', relatedKeysHandler);

export const v1KeysRouter = Router();
v1KeysRouter.get('/keys/:keyId/related', relatedKeysHandler);

const router = Router();
router.use(keysRouter);
router.use(v1KeysRouter);

export default router;
