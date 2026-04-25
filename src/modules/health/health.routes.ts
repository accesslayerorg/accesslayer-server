import { Router } from 'express';
import { healthCheck, simpleHealthCheck, readinessCheck } from './health.controllers';

const router = Router();

// Liveness — simple check for load balancers, no dependency probing
router.get('/', simpleHealthCheck);

// Readiness — checks DB and cache; returns 503 if any critical dep is unavailable
router.get('/ready', readinessCheck);

// Detailed — full diagnostics including memory, system, and db response time
router.get('/detailed', healthCheck);

export default router;
