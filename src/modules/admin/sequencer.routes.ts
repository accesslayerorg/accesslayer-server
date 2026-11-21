import { Router } from 'express';
import { httpClearDrift } from './sequencer.controllers';
import { httpResetQueryCost } from './query-cost.controllers';
import { getCircuitsHealth } from '../health/circuits.controllers';
import { requireInternalNetwork } from '../../middlewares/internal-network.middleware';

const sequencerRouter = Router();

// Multi-tier circuit breaker metrics (#726)
sequencerRouter.get(
   '/health/circuits',
   requireInternalNetwork,
   getCircuitsHealth
);

sequencerRouter.post('/sequencer/clear-drift/:creatorWallet', httpClearDrift);
// Query cost governor admin override (#755).
sequencerRouter.post('/qcost/reset/:walletAddress', httpResetQueryCost);

export const internalRouter = sequencerRouter;
export default sequencerRouter;
