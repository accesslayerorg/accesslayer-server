import { Router, Request, Response, NextFunction } from 'express';
import {
   createGiftSchema,
   giftIdParamSchema,
   listReceivedGiftsQuerySchema,
   walletAddressParamSchema,
} from './gift.schemas';
import { giftService, GiftError } from './gift.service';
import { GiftVerificationError } from './gift-verification.service';

export const giftRouter = Router();

/**
 * Requester identity is taken from the `x-wallet-address` header, which is
 * expected to be set by upstream authentication middleware.
 */
function getRequesterAddress(req: Request): string | undefined {
   const header = req.header('x-wallet-address');
   return header ? header.trim() : undefined;
}

function handleError(err: unknown, res: Response, next: NextFunction) {
   if (err instanceof GiftError || err instanceof GiftVerificationError) {
      return res.status(err.status).json({ error: err.message });
   }
   return next(err);
}

giftRouter.post('/v1/gifts', async (req, res, next) => {
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

giftRouter.get('/v1/wallets/:address/gifts', async (req, res, next) => {
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

giftRouter.post('/v1/gifts/:id/seen', async (req, res, next) => {
   const params = giftIdParamSchema.safeParse(req.params);
   if (!params.success) {
      return res.status(400).json({ error: 'Invalid request' });
   }
   const requester = getRequesterAddress(req);
   if (!requester) {
      return res.status(403).json({ error: 'Missing requester identity' });
   }
   try {
      const gift = await giftService.markSeen(params.data.id, requester);
      return res.json(gift);
   } catch (err) {
      return handleError(err, res, next);
   }
});
