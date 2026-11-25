import { Router } from 'express';
import { httpMultiBuy } from './multi-buy.controllers';
import { platformPauseGuard } from '../../middlewares/platform-pause.middleware';
import { requireDisclosure } from '../../middlewares/require-disclosure.middleware';

const tradingRouter = Router();

// Platform-wide and per-key pause validation (#988) and risk disclosure
// enforcement (#1318) run before the handler.
tradingRouter.post('/multi-buy', platformPauseGuard(), requireDisclosure(), httpMultiBuy);

export default tradingRouter;
