import { Router } from 'express';
import {
   sendSuccess,
   sendNotFound,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { FactoryKeysByCreatorQuerySchema } from './factory.schemas';
import {
   getFactoryKeysByCreator,
   getKeyByFactoryAddress,
   KeyAddressNotFoundError,
} from './factory.service';

const router = Router();

/**
 * GET /factory/keys?creator=<wallet>
 * All keys deployed by that creator wallet, ordered by deployment order.
 */
router.get('/keys', async (req, res, next) => {
   const parsed = FactoryKeysByCreatorQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const keys = await getFactoryKeysByCreator(parsed.data.creator);
      sendSuccess(res, { items: keys });
   } catch (error) {
      next(error);
   }
});

/**
 * GET /factory/keys/:contractAddress
 * Looks up a key by contract address in the factory registry; falls back to
 * the general key registry (is_factory_key: false) when it's a real key that
 * wasn't deployed through the factory. 404 only when the address isn't a key
 * anywhere.
 */
router.get('/keys/:contractAddress', async (req, res, next) => {
   try {
      const result = await getKeyByFactoryAddress(
         String(req.params.contractAddress)
      );
      sendSuccess(res, result);
   } catch (error) {
      if (error instanceof KeyAddressNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      next(error);
   }
});

export default router;
