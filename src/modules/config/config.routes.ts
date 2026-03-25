// src/modules/config/config.routes.ts
import { Router } from 'express';
import { httpGetProtocolConfig } from './config.controllers';

const configRouter = Router();

/**
 * GET /api/v1/config
 * Public endpoint returning protocol bootstrap configuration.
 * Safe for unauthenticated use - no sensitive data exposed.
 */
configRouter.get('/', httpGetProtocolConfig);

export default configRouter;
