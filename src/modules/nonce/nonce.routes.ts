// src/modules/nonce/nonce.routes.ts
// Route definitions for the nonce management API (#1039).

import { Router } from 'express';
import {
   httpGetWalletNonce,
   httpConsumeWalletNonce,
   httpGetTradeNonce,
} from './nonce.controllers';

const router = Router();

/**
 * GET /api/v1/nonce?wallet=
 * Returns the current nonce for a wallet from the on-chain contract, cached with short TTL.
 */
router.get('/', httpGetWalletNonce);

/**
 * GET /nonce/:wallet
 * Issues a fresh one-time nonce stored in Redis with TTL for signed trade replay protection (#1194).
 */
router.get('/:wallet', httpGetTradeNonce);

/**
 * POST /api/v1/nonce/consume
 * Records nonce consumption after an action executes. Rejects consumed nonces with 409.
 */
router.post('/consume', httpConsumeWalletNonce);

export default router;
