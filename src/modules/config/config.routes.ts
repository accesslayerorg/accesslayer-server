// src/modules/config/config.routes.ts
import { Router } from 'express';
import { httpGetProtocolConfig } from './config.controllers';
import { setPublicHeaders } from '../../utils/public-headers.utils';

const configRouter = Router();

/**
 * GET /api/v1/config
 * Public endpoint returning protocol bootstrap configuration.
 * Safe for unauthenticated use - no sensitive data exposed.
 */
configRouter.get('/', setPublicHeaders, httpGetProtocolConfig);

export default configRouter;
