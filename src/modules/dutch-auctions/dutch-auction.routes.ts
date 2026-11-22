import { Router } from 'express';
import { z } from 'zod';
import {
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { CursorChecksumError } from '../../utils/cursor.utils';
import {
   DUTCH_AUCTION_DEFAULT_LIMIT,
   DUTCH_AUCTION_MAX_LIMIT,
   DUTCH_AUCTION_STATUSES,
} from './dutch-auction.constants';
import {
   DutchAuctionNotFoundError,
   getDutchAuction,
   listDutchAuctions,
} from './dutch-auction.service';

const listQuerySchema = z.object({
   keyId: z.string().min(1).optional(),
   status: z.enum(DUTCH_AUCTION_STATUSES).optional(),
   cursor: z.string().min(1).optional(),
   limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(DUTCH_AUCTION_MAX_LIMIT)
      .default(DUTCH_AUCTION_DEFAULT_LIMIT),
});

const router = Router();

/**
 * GET /v1/auctions?keyId=&status=&cursor=
 *
 * Lists Dutch auctions with live `currentPrice` quotes. `status` defaults to
 * `open`, so cancelled and ended auctions are not in the active listing.
 */
router.get('/', async (req, res, next) => {
   const parsed = listQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const result = await listDutchAuctions(parsed.data);
      sendSuccess(res, result, 200, 'Dutch auctions retrieved');
   } catch (error) {
      if (error instanceof CursorChecksumError) {
         sendValidationError(res, 'Invalid cursor');
         return;
      }
      next(error);
   }
});

/** GET /v1/auctions/:id - one Dutch auction with its live quote. */
router.get('/:id', async (req, res, next) => {
   try {
      const quote = await getDutchAuction(req.params.id);
      sendSuccess(res, quote, 200, 'Dutch auction retrieved');
   } catch (error) {
      if (error instanceof DutchAuctionNotFoundError) {
         sendNotFound(res, 'Auction');
         return;
      }
      next(error);
   }
});

export default router;
