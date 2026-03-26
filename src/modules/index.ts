import { Router } from 'express';
import authRouter from './auth/auth.routes';
import healthRouter from './health/health.routes';
import configRouter from './config/config.routes';
import creatorRouter from './creator/creator.routes';

const router = Router();

router.use('/health', healthRouter);
router.use('/auth', authRouter);
router.use('/config', configRouter);
router.use('/creators', creatorRouter);

export default router;
