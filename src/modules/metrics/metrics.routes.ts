import { Router } from 'express';
import { queueMetrics } from './metrics.controllers';

const router = Router();

// Queue depth metrics for all indexer worker queues
router.get('/queues', queueMetrics);

export default router;
