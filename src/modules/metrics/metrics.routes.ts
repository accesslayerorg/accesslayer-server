import { Router } from 'express';
import {
   cacheWarmMetrics,
   creatorReadMetrics,
   orderKeeperMetrics,
   pushMetrics,
   queueMetrics,
   retentionMetrics,
   rpcPoolMetrics,
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

// Web push delivery and retry counters (#1314).
router.get('/push', pushMetrics);

// RPC pool health/failover metrics (#1336).
router.get('/rpc-pool', rpcPoolMetrics);

export default router;
