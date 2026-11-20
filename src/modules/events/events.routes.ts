// src/modules/events/events.routes.ts
// Merkle-proof event integrity routes (#727)

import { Router } from 'express';
import { getEventProofController } from './events.controllers';

const router = Router();

// GET /events/:eventId/proof
router.get('/:eventId/proof', getEventProofController);

export default router;
