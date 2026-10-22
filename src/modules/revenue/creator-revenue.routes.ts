// src/modules/revenue/creator-revenue.routes.ts
import { Router } from 'express';
import {
   getCreatorRevenueHandler,
   getRevenueHistoryHandler,
   withdrawHandler,
} from './creator-revenue.controller';

const router = Router();

router.get('/creators/:wallet/revenue', getCreatorRevenueHandler);
router.get('/creators/:wallet/revenue/history', getRevenueHistoryHandler);
router.post('/creators/:wallet/revenue/withdraw', withdrawHandler);

export default router;
