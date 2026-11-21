import { Router } from 'express';
import { httpMultiBuy } from './multi-buy.controllers';
import { platformPauseGuard } from '../../middlewares/platform-pause.middleware';

const tradingRouter = Router();

// Platform-wide and per-key pause validation (#988) runs before the handler so
// a paused platform/key rejects every leg with 503.
tradingRouter.post('/multi-buy', platformPauseGuard(), httpMultiBuy);

export default tradingRouter;
