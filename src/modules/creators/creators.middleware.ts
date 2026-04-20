// src/modules/creators/creators.middleware.ts
// Reusable param validation middleware for creator routes.

import { NextFunction, Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { sendValidationError } from '../../utils/api-response.utils';

export const CreatorParamsSchema = z.object({
   id: z.string().trim().min(1, 'Creator ID is required'),
});

export type CreatorParams = z.infer<typeof CreatorParamsSchema>;

/**
 * Middleware that validates creator route params before the handler runs.
 *
 * Parses and validates `req.params` against CreatorParamsSchema.
 * Returns a consistent 400 validation error for invalid params so
 * route handlers do not need to repeat this logic.
 *
 * Reusable across any creator route that includes an `:id` param.
 */
export const validateCreatorParams = (
   req: Request,
   res: Response,
   next: NextFunction
): void => {
   try {
      const validated = CreatorParamsSchema.parse(req.params);
      req.params = { ...req.params, ...validated };
      next();
   } catch (error) {
      if (error instanceof ZodError) {
         const details = error.errors.map(err => ({
            field: err.path.join('.'),
            message: err.message,
         }));
         return sendValidationError(
            res,
            'Invalid creator route parameters',
            details
         );
      }

      next(error);
   }
};
