import { Router } from 'express';
import { creatorReadMetrics, queueMetrics } from './metrics.controllers';

const router = Router();

// Queue depth metrics for all indexer worker queues
router.get('/queues', queueMetrics);

// Creator read request duration metrics
router.get('/creators', creatorReadMetrics);

export default router;
