// src/modules/changelog/changelog.routes.ts
// Product changelog endpoints (#1356).
//
// Public:  GET  /changelog?cursor=&category=&limit=
// Wallet:  GET  /changelog/unread-count, POST /changelog/read
// Admin:   GET|POST /admin/changelog, PATCH /admin/changelog/:id,
//          POST /admin/changelog/:id/schedule, POST /admin/changelog/:id/publish

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireJwtAuth, AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import { adminGuard, AdminRequest } from '../../middlewares/admin-guard.middleware';
import {
   sendSuccess,
   sendError,
   sendValidationError,
   zodIssuesToDetails,
   ErrorCode,
   ErrorCodeType,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import {
   CHANGELOG_CATEGORIES,
   ChangelogServiceError,
   createDraftEntry,
   getUnreadCount,
   listAdminEntries,
   listPublishedEntries,
   markAllRead,
   publishEntry,
   scheduleEntry,
   updateEntry,
} from './changelog.service';

const categorySchema = z.preprocess(
   value => (typeof value === 'string' ? value.trim().toUpperCase() : value),
   z.enum(CHANGELOG_CATEGORIES)
);

const httpUrlSchema = z
   .string()
   .trim()
   .max(2048)
   .url()
   .refine(value => /^https?:\/\//i.test(value), 'url must use http or https');

const listQuerySchema = z.object({
   category: categorySchema.optional(),
   cursor: z.string().trim().min(1).max(512).optional(),
   limit: z.coerce.number().int().min(1).max(50).optional(),
});

const createEntrySchema = z.object({
   title: z.string().min(1).max(200),
   body: z.string().min(1).max(20000),
   category: categorySchema,
   version: z.string().trim().min(1).max(50).optional(),
   url: httpUrlSchema.optional(),
});

const updateEntrySchema = z
   .object({
      title: z.string().min(1).max(200).optional(),
      body: z.string().min(1).max(20000).optional(),
      category: categorySchema.optional(),
      version: z.string().trim().min(1).max(50).nullable().optional(),
      url: httpUrlSchema.nullable().optional(),
   })
   .refine(value => Object.keys(value).length > 0, 'At least one field is required');

const scheduleSchema = z.object({
   publishAt: z.string().datetime(),
});

const adminListQuerySchema = z.object({
   status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED']).optional(),
   cursor: z.string().trim().min(1).max(64).optional(),
   limit: z.coerce.number().int().min(1).max(50).optional(),
});

function handleChangelogError(res: Response, error: unknown, context: string): void {
   if (error instanceof ChangelogServiceError) {
      sendError(res, error.statusCode, error.code as ErrorCodeType, error.message);
      return;
   }
   logger.error({ error }, context);
   sendError(res, 500, ErrorCode.INTERNAL_ERROR, context);
}

export const changelogRouter = Router();

changelogRouter.get('/', async (req: Request, res: Response) => {
   const parsed = listQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(res, 'Invalid changelog query', zodIssuesToDetails(parsed.error.issues));
      return;
   }
   try {
      sendSuccess(res, await listPublishedEntries(parsed.data));
   } catch (error) {
      handleChangelogError(res, error, 'Failed to fetch changelog');
   }
});

changelogRouter.get(
   '/unread-count',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      try {
         const unreadCount = await getUnreadCount(req.user!.wallet);
         sendSuccess(res, { unreadCount });
      } catch (error) {
         handleChangelogError(res, error, 'Failed to fetch changelog unread count');
      }
   }
);

changelogRouter.post('/read', requireJwtAuth, async (req: AuthenticatedRequest, res: Response) => {
   try {
      sendSuccess(res, await markAllRead(req.user!.wallet));
   } catch (error) {
      handleChangelogError(res, error, 'Failed to mark changelog read');
   }
});

export const changelogAdminRouter = Router();

changelogAdminRouter.get('/', adminGuard, async (req: AdminRequest, res: Response) => {
   const parsed = adminListQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(res, 'Invalid changelog query', zodIssuesToDetails(parsed.error.issues));
      return;
   }
   try {
      sendSuccess(res, await listAdminEntries(parsed.data));
   } catch (error) {
      handleChangelogError(res, error, 'Failed to list changelog entries');
   }
});

changelogAdminRouter.post('/', adminGuard, async (req: AdminRequest, res: Response) => {
   const parsed = createEntrySchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(res, 'Invalid changelog entry', zodIssuesToDetails(parsed.error.issues));
      return;
   }
   try {
      const entry = await createDraftEntry(parsed.data, req.adminId!);
      sendSuccess(res, { entry }, 201);
   } catch (error) {
      handleChangelogError(res, error, 'Failed to create changelog entry');
   }
});

changelogAdminRouter.patch('/:id', adminGuard, async (req: AdminRequest, res: Response) => {
   const parsed = updateEntrySchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(res, 'Invalid changelog update', zodIssuesToDetails(parsed.error.issues));
      return;
   }
   try {
      const entry = await updateEntry(String(req.params.id), parsed.data);
      sendSuccess(res, { entry });
   } catch (error) {
      handleChangelogError(res, error, 'Failed to update changelog entry');
   }
});

changelogAdminRouter.post('/:id/schedule', adminGuard, async (req: AdminRequest, res: Response) => {
   const parsed = scheduleSchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(res, 'Invalid schedule payload', zodIssuesToDetails(parsed.error.issues));
      return;
   }
   try {
      const entry = await scheduleEntry(String(req.params.id), new Date(parsed.data.publishAt));
      sendSuccess(res, { entry });
   } catch (error) {
      handleChangelogError(res, error, 'Failed to schedule changelog entry');
   }
});

changelogAdminRouter.post('/:id/publish', adminGuard, async (req: AdminRequest, res: Response) => {
   try {
      const entry = await publishEntry(String(req.params.id));
      sendSuccess(res, { entry });
   } catch (error) {
      handleChangelogError(res, error, 'Failed to publish changelog entry');
   }
});
