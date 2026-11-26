// src/modules/relay/relay.routes.ts
// Route definitions for the gasless meta-transaction relay flow (#1088).
//
//   GET  /relay/nonce/:wallet  - reserve the next unused nonce (5-minute TTL)
//   POST /relay/submit         - validate + submit a signed payload on-chain

import { Router } from 'express';
import type { RelaySigner, RelaySubmitter } from './relay.types';
import {
   httpGetRelayNonce,
   httpSubmitRelayTransaction,
} from './relay.controllers';
import { defaultSigner, defaultSubmitter } from './relay.service';
import { relayRateLimit } from './relay.middleware';

/**
 * Builds the relay router with injectable signer/submitter dependencies
 * (defaults to the production implementations).
 *
 * Rate limiting is applied per route (rather than via `router.use`) so that
 * `req.params.wallet` is already populated by Express route matching when the
 * limiter reads the wallet for `GET /relay/nonce/:wallet`.
 */
export function createRelayRouter(
   signer: RelaySigner = defaultSigner,
   submitter: RelaySubmitter = defaultSubmitter
) {
   const router = Router();

   /**
    * GET /relay/nonce/:wallet
    * Returns the next unused nonce for the wallet, reserved for 5 minutes.
    * Rate limited: 10 requests per wallet per minute.
    */
   router.get('/nonce/:wallet', relayRateLimit(), httpGetRelayNonce);

   /**
    * POST /relay/submit
    * Accepts {wallet, nonce, signature, tx_params}, validates the nonce
    * reservation and signature, then submits the transaction on-chain.
    * Rate limited: 10 requests per wallet per minute.
    */
   router.post('/submit', relayRateLimit(), (req, res, next) =>
      httpSubmitRelayTransaction(req, res, next, signer, submitter)
   );

   return router;
}

export const relayRouter = createRelayRouter();

export default relayRouter;
