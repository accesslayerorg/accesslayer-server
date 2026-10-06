// src/modules/acl/acl.controllers.ts
// HTTP controllers for the ACL whitelist admin API (#966).

import { Response } from 'express';
import {
   sendSuccess,
   sendPaginatedSuccess,
   sendNotFound,
   sendConflict,
   sendForbidden,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { AdminRequest } from '../../middlewares/admin-guard.middleware';
import { logger } from '../../utils/logger.utils';
import {
   AddAclEntryBodySchema,
   RemoveAclEntryBodySchema,
   RemoveAclEntryParamsSchema,
   AclPaginationQuerySchema,
} from './acl.schemas';
import {
   addAclEntry,
   removeAclEntry,
   listAclWhitelist,
   getAclHistory,
   AclEntryAlreadyExistsError,
   AclEntryNotFoundError,
   MultisigVerificationError,
} from './acl.service';

/**
 * GET /admin/acl
 * Paginated list of whitelisted contracts with their permitted function
 * sets.
 */
export async function httpListAcl(
   req: AdminRequest,
   res: Response,
   next: (err?: unknown) => void
): Promise<void> {
   try {
      const parsed = AclPaginationQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }
      const { page, limit } = parsed.data;

      const result = await listAclWhitelist(page, limit);

      sendPaginatedSuccess(
         res,
         result.items.map(item => ({
            id: item.id,
            contractAddress: item.contractAddress,
            permittedFunctions: item.permittedFunctions,
            addedBy: item.addedBy,
            createdAt: item.createdAt.toISOString(),
            updatedAt: item.updatedAt.toISOString(),
         })),
         {
            page: result.page,
            limit: result.limit,
            totalCount: result.totalCount,
            totalPages: result.totalPages,
            hasNextPage: result.page < result.totalPages,
            hasPrevPage: result.page > 1,
         }
      );
   } catch (error) {
      logger.error({ error }, 'ACL list failed');
      next(error);
   }
}

/**
 * POST /admin/acl
 * Add a contract address and its permitted function list to the on-chain
 * ACL whitelist. Requires admin JWT + 2-of-3 multisig signatures.
 */
export async function httpAddAcl(
   req: AdminRequest,
   res: Response,
   next: (err?: unknown) => void
): Promise<void> {
   try {
      const parsed = AddAclEntryBodySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid request body',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      const entry = await addAclEntry({
         contractAddress: parsed.data.contractAddress,
         permittedFunctions: parsed.data.permittedFunctions,
         signatures: parsed.data.signatures,
         actor: req.adminId || 'unknown',
      });

      sendSuccess(
         res,
         {
            id: entry.id,
            contractAddress: entry.contractAddress,
            permittedFunctions: entry.permittedFunctions,
            addedBy: entry.addedBy,
            createdAt: entry.createdAt.toISOString(),
         },
         201
      );
   } catch (error) {
      if (error instanceof MultisigVerificationError) {
         sendForbidden(res, error.message);
         return;
      }
      if (error instanceof AclEntryAlreadyExistsError) {
         sendConflict(res, error.message);
         return;
      }
      logger.error({ error }, 'ACL add failed');
      next(error);
   }
}

/**
 * DELETE /admin/acl/:contractId
 * Remove a contract from the on-chain ACL whitelist. Requires admin JWT +
 * 2-of-3 multisig signatures.
 */
export async function httpRemoveAcl(
   req: AdminRequest,
   res: Response,
   next: (err?: unknown) => void
): Promise<void> {
   try {
      const paramsParsed = RemoveAclEntryParamsSchema.safeParse(req.params);
      if (!paramsParsed.success) {
         sendValidationError(
            res,
            'Invalid path parameters',
            zodIssuesToDetails(paramsParsed.error.issues)
         );
         return;
      }

      const bodyParsed = RemoveAclEntryBodySchema.safeParse(req.body);
      if (!bodyParsed.success) {
         sendValidationError(
            res,
            'Invalid request body',
            zodIssuesToDetails(bodyParsed.error.issues)
         );
         return;
      }

      const removed = await removeAclEntry({
         contractId: paramsParsed.data.contractId,
         signatures: bodyParsed.data.signatures,
         actor: req.adminId || 'unknown',
      });

      sendSuccess(res, {
         id: removed.id,
         contractAddress: removed.contractAddress,
         removed: true,
      });
   } catch (error) {
      if (error instanceof MultisigVerificationError) {
         sendForbidden(res, error.message);
         return;
      }
      if (error instanceof AclEntryNotFoundError) {
         sendNotFound(res, 'Whitelist entry');
         return;
      }
      logger.error(
         { error, contractId: req.params.contractId },
         'ACL remove failed'
      );
      next(error);
   }
}

/**
 * GET /admin/acl/history
 * Paginated add/remove event log with actor and timestamp.
 */
export async function httpGetAclHistory(
   req: AdminRequest,
   res: Response,
   next: (err?: unknown) => void
): Promise<void> {
   try {
      const parsed = AclPaginationQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }
      const { page, limit } = parsed.data;

      const result = await getAclHistory(page, limit);

      sendPaginatedSuccess(
         res,
         result.items.map(item => ({
            id: item.id,
            eventType: item.eventType,
            contractAddress: item.contractAddress,
            permittedFunctions: item.permittedFunctions,
            actor: item.actor,
            signers: item.signers,
            createdAt: item.createdAt.toISOString(),
         })),
         {
            page: result.page,
            limit: result.limit,
            totalCount: result.totalCount,
            totalPages: result.totalPages,
            hasNextPage: result.page < result.totalPages,
            hasPrevPage: result.page > 1,
         }
      );
   } catch (error) {
      logger.error({ error }, 'ACL history fetch failed');
      next(error);
   }
}
