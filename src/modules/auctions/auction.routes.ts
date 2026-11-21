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
   AuctionClosedError,
   AuctionNotFoundError,
   BidValidationError,
   closeAuction,
   getAuctionBids,
   submitBid,
} from './auction.service';

const bidSchema = z.object({
   bidderId: z.string().min(1, 'bidderId is required'),
   amount: z.coerce.number().positive('amount must be positive'),
});

const router = Router();

router.post('/:id/bid', async (req, res, next) => {
   const parsed = bidSchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid bid payload',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const result = await submitBid(req.params.id, parsed.data.bidderId, parsed.data.amount);
      sendSuccess(res, result, 200, 'Bid accepted');
   } catch (error) {
      if (error instanceof AuctionNotFoundError) {
         sendNotFound(res, 'Auction');
         return;
      }
      if (error instanceof AuctionClosedError) {
         sendError(
            res,
            409,
            ErrorCode.CONFLICT,
            error.message
         );
         return;
      }
      if (error instanceof BidValidationError) {
         sendValidationError(res, error.message);
         return;
      }
      next(error);
   }
});

router.get('/:id/bids', async (req, res, next) => {
   try {
      const bids = await getAuctionBids(req.params.id);
      sendSuccess(res, bids, 200, 'Auction bids retrieved');
   } catch (error) {
      if (error instanceof AuctionNotFoundError) {
         sendNotFound(res, 'Auction');
         return;
      }
      next(error);
   }
});

export { closeAuction };
export default router;
