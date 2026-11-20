// src/modules/admin/key-allowlist.controller.ts
//
// POST /admin/keys/:keyId/allowlist/import (#1246)
//
// Accepts a multipart/form-data upload in the `file` field, validates the CSV
// and imports the valid rows into the key's early-access allowlist.

import { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { AsyncController } from '../../types/auth.types';
import {
   sendError,
   sendNotFound,
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { prisma } from '../../utils/prisma.utils';
import {
   AllowlistCsvParseError,
   AllowlistFileTooLargeError,
   AllowlistRowLimitExceededError,
   importAllowlistCsv,
   MAX_ALLOWLIST_FILE_BYTES,
} from '../keys/key-allowlist.service';

const upload = multer({
   storage: multer.memoryStorage(),
   limits: {
      fileSize: MAX_ALLOWLIST_FILE_BYTES,
      files: 1,
   },
});

/**
 * Parses the multipart upload (field name `file`) and maps multer's size
 * limit error to a 413 response before the handler runs.
 */
export function allowlistCsvUpload(
   req: Request,
   res: Response,
   next: NextFunction
): void {
   upload.single('file')(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError) {
         if (error.code === 'LIMIT_FILE_SIZE') {
            return sendError(
               res,
               413,
               ErrorCode.BAD_REQUEST,
               'CSV file exceeds the 2 MB limit'
            );
         }
         return sendError(
            res,
            400,
            ErrorCode.VALIDATION_ERROR,
            'Invalid multipart upload',
            [{ field: 'file', message: error.message }]
         );
      }
      if (error) {
         return next(error);
      }
      return next();
   });
}

/**
 * Imports the uploaded CSV into the allowlist of the key identified by
 * `:keyId` (creator profile id or handle). Supports `?dryRun=true`.
 */
export const httpImportKeyAllowlist: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const keyId = String(req.params.keyId);

      if (!req.file) {
         return sendValidationError(res, 'CSV file is required', [
            { field: 'file', message: 'Upload a CSV file in the "file" field' },
         ]);
      }

      const dryRun =
         String(req.query.dryRun ?? 'false').toLowerCase() === 'true';

      const creator = await prisma.creatorProfile.findFirst({
         where: { OR: [{ id: keyId }, { handle: keyId }] },
         select: { id: true },
      });
      if (!creator) {
         return sendNotFound(res, 'Key');
      }

      const report = await importAllowlistCsv(creator.id, req.file.buffer, {
         dryRun,
      });
      return sendSuccess(res, report);
   } catch (error) {
      if (error instanceof AllowlistFileTooLargeError) {
         return sendError(res, 413, ErrorCode.BAD_REQUEST, error.message);
      }
      if (error instanceof AllowlistRowLimitExceededError) {
         return sendError(res, 400, ErrorCode.VALIDATION_ERROR, error.message);
      }
      if (error instanceof AllowlistCsvParseError) {
         return sendError(res, 400, ErrorCode.VALIDATION_ERROR, error.message);
      }
      next(error);
   }
};
