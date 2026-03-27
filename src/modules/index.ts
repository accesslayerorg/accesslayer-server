import { Router } from 'express';
import authRouter from './auth/auth.routes';
import healthRouter from './health/health.routes';
import configRouter from './config/config.routes';
import creatorRouter from './creator/creator.routes';
import { BASE as CREATORS_BASE } from '../constants/creator.constants';

const router = Router();

router.use('/health', healthRouter);
router.use('/auth', authRouter);
router.use('/config', configRouter);
router.use(CREATORS_BASE, creatorRouter);

export default router;
