// src/modules/collections/collections.routes.ts
// Curated collections (#1353):
// - collectionsRouter, mounted at /collections: public published listings,
//   editor-only management (JWT wallet must be a collection editor) and
//   follow / unfollow.
// - followedCollectionsRouter, mounted at /me: the caller's followed list.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
   requireJwtAuth,
   AuthenticatedRequest,
} from '../../middlewares/jwt-auth.middleware';
import {
   sendSuccess,
   sendError,
   sendPaginatedSuccess,
   sendValidationError,
   zodIssuesToDetails,
   ErrorCode,
   ErrorCodeType,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import { isValidStellarAddress } from '../wallet/wallet.utils';
import {
   CollectionServiceError,
   MAX_COLLECTION_EDITORS,
   MAX_COLLECTION_ITEMS,
   addCollectionItem,
   createCollection,
   followCollection,
   getPublishedCollectionWithItems,
   listFollowedCollections,
   listPublishedCollections,
   removeCollectionItem,
   reorderCollectionItems,
   unfollowCollection,
   updateCollection,
} from './collections.service';

const slugSchema = z
   .string()
   .trim()
   .toLowerCase()
   .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'slug must be lowercase letters, digits and single hyphens'
   )
   .min(3)
   .max(64);

const listQuerySchema = z.object({
   page: z.coerce.number().int().min(1).max(10_000).default(1),
   limit: z.coerce.number().int().min(1).max(50).default(20),
});

const createSchema = z.object({
   slug: slugSchema,
   title: z.string().trim().min(1).max(120),
   description: z.string().trim().max(1000).optional(),
});

const updateSchema = z
   .object({
      title: z.string().trim().min(1).max(120).optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
      editorWallets: z
         .array(
            z.string().refine(isValidStellarAddress, {
               message: 'must be a valid Stellar address',
            })
         )
         .min(1)
         .max(MAX_COLLECTION_EDITORS)
         .optional(),
   })
   .refine(body => Object.keys(body).length > 0, {
      message: 'Provide at least one field to update',
   });

const addItemSchema = z.object({
   keyId: z.string().trim().min(1).max(128),
   note: z.string().trim().min(1).max(500).optional(),
});

const reorderSchema = z.object({
   orderedKeyIds: z
      .array(z.string().trim().min(1).max(128))
      .min(1)
      .max(MAX_COLLECTION_ITEMS),
});

function handleCollectionError(
   res: Response,
   error: unknown,
   context: string
): void {
   if (error instanceof CollectionServiceError) {
      sendError(res, error.statusCode, error.code as ErrorCodeType, error.message);
      return;
   }
   logger.error({ error }, context);
   sendError(res, 500, ErrorCode.INTERNAL_ERROR, context);
}

function parseSlug(req: Request, res: Response): string | null {
   const parsed = slugSchema.safeParse(req.params.slug);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid collection slug',
         zodIssuesToDetails(parsed.error.issues)
      );
      return null;
   }
   return parsed.data;
}

export const collectionsRouter = Router();

collectionsRouter.get('/', async (req: Request, res: Response) => {
   const query = listQuerySchema.safeParse(req.query);
   if (!query.success) {
      sendValidationError(res, 'Invalid query', zodIssuesToDetails(query.error.issues));
      return;
   }
   try {
      const { data, meta } = await listPublishedCollections(query.data);
      sendPaginatedSuccess(res, data, meta);
   } catch (error) {
      handleCollectionError(res, error, 'Failed to list collections');
   }
});

collectionsRouter.post(
   '/',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid collection payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }
      try {
         const collection = await createCollection({
            wallet: req.user!.wallet,
            ...parsed.data,
         });
         sendSuccess(res, { collection }, 201);
      } catch (error) {
         handleCollectionError(res, error, 'Failed to create collection');
      }
   }
);

collectionsRouter.get('/:slug', async (req: Request, res: Response) => {
   const slug = parseSlug(req, res);
   if (!slug) return;
   try {
      const collection = await getPublishedCollectionWithItems(slug);
      sendSuccess(res, { collection });
   } catch (error) {
      handleCollectionError(res, error, 'Failed to fetch collection');
   }
});

collectionsRouter.patch(
   '/:slug',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      const slug = parseSlug(req, res);
      if (!slug) return;
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid collection update payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }
      try {
         const collection = await updateCollection({
            wallet: req.user!.wallet,
            slug,
            ...parsed.data,
         });
         sendSuccess(res, { collection });
      } catch (error) {
         handleCollectionError(res, error, 'Failed to update collection');
      }
   }
);

collectionsRouter.post(
   '/:slug/items',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      const slug = parseSlug(req, res);
      if (!slug) return;
      const parsed = addItemSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid collection item payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }
      try {
         const item = await addCollectionItem({
            wallet: req.user!.wallet,
            slug,
            ...parsed.data,
         });
         sendSuccess(res, { item }, 201);
      } catch (error) {
         handleCollectionError(res, error, 'Failed to add collection item');
      }
   }
);

collectionsRouter.put(
   '/:slug/items/order',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      const slug = parseSlug(req, res);
      if (!slug) return;
      const parsed = reorderSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid collection order payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }
      try {
         const items = await reorderCollectionItems({
            wallet: req.user!.wallet,
            slug,
            orderedKeyIds: parsed.data.orderedKeyIds,
         });
         sendSuccess(res, { items });
      } catch (error) {
         handleCollectionError(res, error, 'Failed to reorder collection items');
      }
   }
);

collectionsRouter.delete(
   '/:slug/items/:keyId',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      const slug = parseSlug(req, res);
      if (!slug) return;
      try {
         await removeCollectionItem({
            wallet: req.user!.wallet,
            slug,
            keyId: String(req.params.keyId),
         });
         res.status(204).send();
      } catch (error) {
         handleCollectionError(res, error, 'Failed to remove collection item');
      }
   }
);

collectionsRouter.post(
   '/:slug/follow',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      const slug = parseSlug(req, res);
      if (!slug) return;
      try {
         const result = await followCollection({ wallet: req.user!.wallet, slug });
         sendSuccess(res, result);
      } catch (error) {
         handleCollectionError(res, error, 'Failed to follow collection');
      }
   }
);

collectionsRouter.delete(
   '/:slug/follow',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      const slug = parseSlug(req, res);
      if (!slug) return;
      try {
         const result = await unfollowCollection({ wallet: req.user!.wallet, slug });
         sendSuccess(res, result);
      } catch (error) {
         handleCollectionError(res, error, 'Failed to unfollow collection');
      }
   }
);

export const followedCollectionsRouter = Router();

followedCollectionsRouter.get(
   '/followed-collections',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      try {
         const collections = await listFollowedCollections(req.user!.wallet);
         sendSuccess(res, { collections });
      } catch (error) {
         handleCollectionError(res, error, 'Failed to list followed collections');
      }
   }
);
