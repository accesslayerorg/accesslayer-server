import { Router } from 'express';
import { httpGetOwnership } from './ownership.controllers';

const ownershipRouter = Router();

/**
 * GET /api/v1/ownership
 * 
 * Lookup key ownership by owner address or creator ID.
 */
ownershipRouter.get('/', httpGetOwnership);

export default ownershipRouter;
