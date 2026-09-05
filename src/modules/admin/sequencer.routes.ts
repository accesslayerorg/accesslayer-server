import { Router } from 'express';
import { httpClearDrift } from './sequencer.controllers';
import { httpResetQueryCost } from './query-cost.controllers';

const sequencerRouter = Router();

sequencerRouter.post('/sequencer/clear-drift/:creatorWallet', httpClearDrift);
// Query cost governor admin override (#755).
sequencerRouter.post('/qcost/reset/:walletAddress', httpResetQueryCost);

export default sequencerRouter;
