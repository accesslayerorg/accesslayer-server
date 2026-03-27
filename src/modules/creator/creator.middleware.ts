import { NextFunction, Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { sendValidationError } from '../../utils/api-response.utils';

export const CreatorIdParamsSchema = z.object({
   id: z.string().trim().min(1, 'Creator ID is required'),
});

export type CreatorIdParams = z.infer<typeof CreatorIdParamsSchema>;

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
