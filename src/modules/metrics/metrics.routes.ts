import { Router } from 'express';
import {
   cacheWarmMetrics,
   creatorReadMetrics,
   orderKeeperMetrics,
   queueMetrics,
   retentionMetrics,
} from './metrics.controllers';

const router = Router();

// Queue depth metrics for all indexer worker queues
router.get('/queues', queueMetrics);

// Creator read request duration metrics
router.get('/creators', creatorReadMetrics);

// Cache warmer duration and failure metrics
router.get('/cache-warm', cacheWarmMetrics);

// Limit order keeper fill and skip counters
router.get('/order-keeper', orderKeeperMetrics);

// Rows deleted by the retention worker, in Prometheus exposition format.
router.get('/retention', retentionMetrics);

export default router;
