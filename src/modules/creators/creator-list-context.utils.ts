import { Request } from 'express';

export type CreatorListRequestContext = {
   query: Request['query'];
};

/**
 * Build a lightweight request context for creator list handlers.
 * Keeps the surface small and predictable for public list routes.
 */
export const buildCreatorListRequestContext = (
   req: Request
): CreatorListRequestContext => ({
   query: req.query,
});
