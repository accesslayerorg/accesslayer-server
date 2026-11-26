import { Router, Response, NextFunction } from 'express';
import {
   createGiftSchema,
   giftIdParamSchema,
   listReceivedGiftsQuerySchema,
   walletAddressParamSchema,
} from './gift.schemas';
import { giftService, GiftError } from './gift.service';
import {
   requireJwtAuth,
   requireWalletParamMatch,
   AuthenticatedRequest,
} from '../../middlewares/jwt-auth.middleware';

export const giftRouter = Router();

function handleError(err: unknown, res: Response, next: NextFunction) {
   if (err instanceof GiftError) {
      return res.status(err.status).json({ error: err.message });
   }
   return next(err);
}

giftRouter.post('/gifts', async (req, res, next) => {
   const parsed = createGiftSchema.safeParse(req.body);
   if (!parsed.success) {
      return res
         .status(400)
         .json({ error: 'Invalid request', details: parsed.error.flatten() });
   }
   try {
      const gift = await giftService.createGift(parsed.data);
      return res.status(201).json(gift);
   } catch (err) {
      return handleError(err, res, next);
   }
});

giftRouter.get('/wallets/:address/gifts', requireWalletParamMatch('address'), async (req, res, next) => {
   const params = walletAddressParamSchema.safeParse(req.params);
   const query = listReceivedGiftsQuerySchema.safeParse(req.query);
   if (!params.success || !query.success) {
      return res.status(400).json({ error: 'Invalid request' });
   }
   try {
      const gifts = await giftService.listReceivedGifts(
         params.data.address,
         query.data.unseen ?? false
      );
      return res.json(gifts);
   } catch (err) {
      return handleError(err, res, next);
   }
});

giftRouter.post('/gifts/:id/seen', requireJwtAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
   const params = giftIdParamSchema.safeParse(req.params);
   if (!params.success) {
      return res.status(400).json({ error: 'Invalid request' });
   }
   const requester = req.user!.wallet;
   try {
      const gift = await giftService.markSeen(params.data.id, requester);
      return res.json(gift);
   } catch (err) {
      return handleError(err, res, next);
   }
});
