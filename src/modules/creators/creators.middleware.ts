import { NextFunction, Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { sendValidationError } from '../../utils/api-response.utils';

/**
 * Zod schema for creator route parameters.
 * Validates that 'id' is a non-empty string.
 */
export const CreatorIdParamsSchema = z.object({
   id: z.string().trim().min(1, 'Creator ID is required'),
});

export type CreatorIdParams = z.infer<typeof CreatorIdParamsSchema>;

/**
 * Middleware to validate creator route parameters (e.g., :id).
 *
 * Uses Zod to parse and validate 'req.params'.
 * If validation fails, returns a 400 Bad Request with details.
 * If successful, attaches validated params back to 'req.params' and proceeds.
 *
 * @example
 * router.get('/:id/stats', validateCreatorIdParam, httpGetCreatorStats);
 */
export const validateCreatorIdParam = (
   req: Request,
   res: Response,
   next: NextFunction
): void => {
   try {
      const validatedParams = CreatorIdParamsSchema.parse(req.params);
      req.params = {
         ...req.params,
         ...validatedParams,
      };
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
