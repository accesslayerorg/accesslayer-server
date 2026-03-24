import { Router } from 'express';
import { healthCheck, simpleHealthCheck } from './health.controllers';

const router = Router();

// Detailed health check with database connectivity
router.get('/detailed', healthCheck);

// Simple health check for load balancers
router.get('/', simpleHealthCheck);

export default router;
