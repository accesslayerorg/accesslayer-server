import { Router } from 'express';
import {
   cacheWarmMetrics,
   creatorReadMetrics,
   queueMetrics,
} from './metrics.controllers';

const router = Router();

// Queue depth metrics for all indexer worker queues
router.get('/queues', queueMetrics);

// Creator read request duration metrics
router.get('/creators', creatorReadMetrics);

// Cache warmer duration and failure metrics
router.get('/cache-warm', cacheWarmMetrics);

export default router;
