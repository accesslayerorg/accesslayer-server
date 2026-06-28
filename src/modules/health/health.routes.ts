import { Router } from 'express';
import {
  healthCheck,
  readinessCheck,
  simpleHealthCheck,
  indexerHeartbeatCheck,
  recordIndexerHeartbeat,
} from './health.controllers';

const router = Router();

// Liveness — simple check for load balancers, no dependency probing
router.get('/', simpleHealthCheck);

// Indexer heartbeat — check worker status
router.get('/indexer', indexerHeartbeatCheck);

// Indexer heartbeat — record a successful worker run
router.post('/indexer/heartbeat', recordIndexerHeartbeat);
// Readiness — checks DB and cache; returns 503 if any critical dep is unavailable
router.get('/ready', readinessCheck);

// Detailed — full diagnostics including memory, system, and db response time
router.get('/detailed', healthCheck);

export default router;
