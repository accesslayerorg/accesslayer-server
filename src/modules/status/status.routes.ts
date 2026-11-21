// src/modules/status/status.routes.ts
// Platform status health check API routes (#1015).

import { Router } from 'express';
import {
   getStatus,
   getStatusHistory,
   getStatusIncidents,
   postStatusIncident,
} from './status.controllers';
import { requireStatusAdminWallet } from './status.auth';

const statusRouter = Router();

// GET /status — current health of all services with status and last checked timestamp
statusRouter.get('/', getStatus);

// GET /status/history — 30-day uptime percentage per service
statusRouter.get('/history', getStatusHistory);

// GET /status/incidents — paginated incident log with title, services, start, and resolution
statusRouter.get('/incidents', getStatusIncidents);

// POST /status/incidents — incident records created manually by admin via POST /status/incidents
statusRouter.post('/incidents', requireStatusAdminWallet, postStatusIncident);

export default statusRouter;
