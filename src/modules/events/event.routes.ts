// src/modules/events/event.routes.ts
import { Router } from 'express';
import { httpGetEventProof } from './event.controllers';

const eventsRouter = Router();

/**
 * GET /api/v1/events/:eventId/proof
 * Public endpoint returning Merkle inclusion proof for a closed partition event.
 */
eventsRouter.get('/:eventId/proof', httpGetEventProof);

export default eventsRouter;
