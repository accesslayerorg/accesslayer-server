// src/modules/staking/staking-epoch.routes.ts
// Staking epoch REST endpoints (#1086).
//
//   GET /staking/:wallet/positions            — active stakes with live rewards
//   GET /staking/:wallet/positions/:stakeId   — single stake + epoch breakdown
//   GET /keys/:keyId/epochs                   — epoch reward history for a key

import { Router } from 'express';
import {
   requireJwtAuth,
   requireWalletParamMatch,
} from '../../middlewares/jwt-auth.middleware';
import {
   httpGetStakingPositions,
   httpGetStakingPosition,
   httpGetKeyEpochs,
} from './staking-epoch.controller';

const stakingEpochRouter = Router();

// ── Staking position endpoints (wallet-scoped) ────────────────

stakingEpochRouter.get(
   '/:wallet/positions',
   requireWalletParamMatch('wallet'),
   httpGetStakingPositions
);
stakingEpochRouter.all('/:wallet/positions', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

stakingEpochRouter.get(
   '/:wallet/positions/:stakeId',
   requireWalletParamMatch('wallet'),
   httpGetStakingPosition
);
stakingEpochRouter.all('/:wallet/positions/:stakeId', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export { stakingEpochRouter };

// ── Key epoch history (public, JWT still required for consistency) ─

const keyEpochRouter = Router();

keyEpochRouter.get('/:keyId/epochs', requireJwtAuth, httpGetKeyEpochs);
keyEpochRouter.all('/:keyId/epochs', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export { keyEpochRouter };
