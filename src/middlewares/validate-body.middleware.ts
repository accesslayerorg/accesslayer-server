// src/middlewares/validate-body.middleware.ts
// Centralized Zod request body validation.
//
// Mount `validateBody(schema)` ahead of a route handler to validate
// `req.body` before it reaches business logic. Unknown fields are stripped
// (the default behavior of `z.object()`), and invalid payloads short-circuit
// with a structured 422 response instead of reaching the controller.

import type { Request, Response, NextFunction } from 'express';
import type { ZodTypeAny } from 'zod';
import {
   sendError,
   zodIssuesToDetails,
   ErrorCode,
} from '../utils/api-response.utils';

/**
 * Builds middleware that validates `req.body` against `schema` via
 * `safeParse`, replacing `req.body` with the parsed (and unknown-field
 * stripped) result on success.
 *
 * On failure, responds 422 with `{ error: { code: VALIDATION_ERROR, details } }`
 * where `details` lists every invalid field and its message — the handler is
 * never invoked.
 */
export function validateBody(schema: ZodTypeAny) {
   return (req: Request, res: Response, next: NextFunction): void => {
      const result = schema.safeParse(req.body);

      if (!result.success) {
         sendError(
            res,
            422,
            ErrorCode.VALIDATION_ERROR,
            'Invalid request body',
            zodIssuesToDetails(result.error.issues)
         );
         return;
      }

      req.body = result.data;
      next();
   };
}
