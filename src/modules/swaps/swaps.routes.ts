// src/modules/swaps/swaps.routes.ts
// Route definitions for atomic swap proposal REST endpoints (#1087)

import { Router } from 'express';
import {
   httpGetOutgoingSwaps,
   httpGetIncomingSwaps,
   httpGetSwapById,
} from './swaps.controllers';

const swapsRouter = Router();

/**
 * GET /swaps/:wallet/outgoing
 * Paginated outgoing proposals with status and expiry countdown
 */
swapsRouter.get('/:wallet/outgoing', httpGetOutgoingSwaps);

/**
 * GET /swaps/:wallet/incoming
 * Paginated incoming proposals awaiting acceptance
 */
swapsRouter.get('/:wallet/incoming', httpGetIncomingSwaps);

/**
 * GET /swaps/:swap_id
 * Single swap detail with offered/requested key and amount data
 */
swapsRouter.get('/:swap_id', httpGetSwapById);

export default swapsRouter;
