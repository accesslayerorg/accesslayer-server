import { Router } from 'express';
import {
  healthCheck,
  simpleHealthCheck,
  indexerHeartbeatCheck,
  recordIndexerHeartbeat,
} from './health.controllers';

const router = Router();

// Detailed health check with database connectivity
router.get('/detailed', healthCheck);

// Simple health check for load balancers
router.get('/', simpleHealthCheck);

// Indexer heartbeat — check worker status
router.get('/indexer', indexerHeartbeatCheck);

// Indexer heartbeat — record a successful worker run
router.post('/indexer/heartbeat', recordIndexerHeartbeat);

export default router;
