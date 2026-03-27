import { Router } from 'express';
import { httpListCreators } from './creators.controllers';
<<<<<<< feat/public-headers-helper
import { setPublicHeaders } from '../../utils/public-headers.utils';
=======
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { PUBLIC_ENDPOINT_CACHE_PRESETS } from '../../constants/public-endpoint-cache.constants';
>>>>>>> main

const creatorsRouter = Router();

/**
 * GET /api/v1/creators
 *
 * List all creators with pagination and filtering.
 * Public endpoint with 5-minute cache.
 */
<<<<<<< feat/public-headers-helper
creatorsRouter.get('/', setPublicHeaders, httpListCreators);
=======
creatorsRouter.get(
   '/',
   cacheControl(PUBLIC_ENDPOINT_CACHE_PRESETS.short),
   httpListCreators
);
>>>>>>> main

export default creatorsRouter;
