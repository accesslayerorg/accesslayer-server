// src/modules/auth/passkey.routes.ts
// WebAuthn passkey registration & authentication routes (#1313).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
   sendSuccess,
   sendError,
   sendValidationError,
   zodIssuesToDetails,
   ErrorCode,
   ErrorCodeType,
} from '../../utils/api-response.utils';
import {
   createPasskeyRegistrationOptions,
   verifyPasskeyRegistration,
   createPasskeyLoginOptions,
   verifyPasskeyLogin,
   PasskeyServiceError,
} from './passkey.service';
import { logger } from '../../utils/logger.utils';

const router = Router();

const registerOptionsSchema = z.object({
   userId: z.string().min(1),
   email: z.string().email(),
   displayName: z.string().optional(),
});

const registerVerifySchema = z.object({
   userId: z.string().min(1),
   response: z.record(z.unknown()),
});

const loginOptionsSchema = z.object({
   userId: z.string().min(1).optional(),
});

const loginVerifySchema = z.object({
   challengeId: z.string().min(1),
   response: z.record(z.unknown()),
});

function handlePasskeyError(res: Response, error: unknown, context: string): void {
   if (error instanceof PasskeyServiceError) {
      sendError(res, error.statusCode, error.code as ErrorCodeType, error.message);
      return;
   }
   logger.error({ error }, context);
   sendError(res, 500, ErrorCode.INTERNAL_ERROR, context);
}

router.post('/register/options', async (req: Request, res: Response) => {
   const parsed = registerOptionsSchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid passkey registration options request',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const origin = req.get('origin') ?? undefined;
      const result = await createPasskeyRegistrationOptions({
         ...parsed.data,
         origin,
      });
      sendSuccess(res, result);
   } catch (error) {
      handlePasskeyError(res, error, 'Failed to generate registration options');
   }
});

router.post('/register/verify', async (req: Request, res: Response) => {
   const parsed = registerVerifySchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid passkey registration verification request',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const origin = req.get('origin') ?? undefined;
      const result = await verifyPasskeyRegistration({
         userId: parsed.data.userId,
         response: parsed.data.response as any,
         origin,
      });
      sendSuccess(res, result);
   } catch (error) {
      handlePasskeyError(res, error, 'Failed to verify passkey registration');
   }
});

router.post('/login/options', async (req: Request, res: Response) => {
   const parsed = loginOptionsSchema.safeParse(req.body ?? {});
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid passkey login options request',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const origin = req.get('origin') ?? undefined;
      const result = await createPasskeyLoginOptions({
         userId: parsed.data.userId,
         origin,
      });
      sendSuccess(res, result);
   } catch (error) {
      handlePasskeyError(res, error, 'Failed to generate login options');
   }
});

router.post('/login/verify', async (req: Request, res: Response) => {
   const parsed = loginVerifySchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid passkey login verification request',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const origin = req.get('origin') ?? undefined;
      const result = await verifyPasskeyLogin({
         challengeId: parsed.data.challengeId,
         response: parsed.data.response as any,
         origin,
      });
      sendSuccess(res, result);
   } catch (error) {
      handlePasskeyError(res, error, 'Failed to verify passkey login');
   }
});

export default router;
