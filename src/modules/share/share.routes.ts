import { Router } from 'express';
import { httpGetCreatorShare, httpGetCreatorShareImage } from './share.controller';

const shareRouter = Router();

/**
 * GET /api/v1/share/creators/:handle
 *
 * Returns HTML with Open Graph and Twitter card metadata for a creator.
 * Includes meta refresh redirecting browsers to the client URL.
 */
shareRouter.get(
   '/creators/:handle',
   httpGetCreatorShare
);

/**
 * GET /api/v1/share/creators/:handle/image.png
 *
 * Returns a 1200x630 PNG card with creator name, price, and holder count.
 * Image is cached in Redis for 10 minutes keyed by handle and price bucket.
 */
shareRouter.get(
   '/creators/:handle/image.png',
   httpGetCreatorShareImage
);

export default shareRouter;