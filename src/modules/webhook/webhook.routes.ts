import { Router } from 'express';
import { httpRegisterWebhook, httpSimulateTrade } from './webhook.controllers';

const router = Router();

router.post('/', httpRegisterWebhook);
router.post('/simulate-trade', httpSimulateTrade);

export default router;
