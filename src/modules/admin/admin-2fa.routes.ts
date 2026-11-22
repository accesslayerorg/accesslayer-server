import { Router } from 'express';
import { z } from 'zod';
import { pendingAdminGuard } from '../../middlewares/admin-guard.middleware';
import { validateBody } from '../../middlewares/validate-body.middleware';
import {
   httpAdminTotpLogin,
   httpAdminTotpSetup,
   httpAdminTotpVerify,
} from './admin-2fa.controllers';

const totpCodeSchema = z
   .string()
   .regex(/^\d{6}$/, 'Verification code must be 6 digits');

export const AdminTotpVerifySchema = z.object({
   code: totpCodeSchema,
});

export const AdminTotpLoginSchema = z
   .object({
      code: totpCodeSchema.optional(),
      recoveryCode: z.string().trim().min(8).max(32).optional(),
   })
   .refine(value => Boolean(value.code || value.recoveryCode), {
      message: 'A verification code or recovery code is required',
      path: ['code'],
   });

export const admin2faRouter = Router();

admin2faRouter.post('/setup', pendingAdminGuard, httpAdminTotpSetup);
admin2faRouter.post(
   '/verify',
   pendingAdminGuard,
   validateBody(AdminTotpVerifySchema),
   httpAdminTotpVerify
);
admin2faRouter.post(
   '/login',
   pendingAdminGuard,
   validateBody(AdminTotpLoginSchema),
   httpAdminTotpLogin
);

export default admin2faRouter;
