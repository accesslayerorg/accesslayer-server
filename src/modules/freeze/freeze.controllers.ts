import { AsyncController } from '../../types/auth.types';
import { sendSuccess, sendValidationError, sendNotFound } from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { KeyIdParamSchema, FreezeBodySchema, UnfreezeBodySchema } from './freeze.schemas';
import { getFreezeStatus, emergencyFreeze, initiateUnfreeze } from './freeze.service';
import { prisma } from '../../utils/prisma.utils';

export const httpGetFreezeStatus: AsyncController = async (req, res, next) => {
  try {
    const parsed = KeyIdParamSchema.safeParse(req.params);
    if (!parsed.success) return sendValidationError(res, 'Invalid keyId', parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
    const exists = await prisma.keyOwnership.findFirst({ where: { creatorId: parsed.data.keyId } });
    if (!exists) return sendNotFound(res, 'Key');
    const status = await getFreezeStatus(parsed.data.keyId);
    attachTimestampHeader(res);
    sendSuccess(res, status);
  } catch (e) { next(e); }
};

export const httpEmergencyFreeze: AsyncController = async (req: any, res, next) => {
  try {
    const params = KeyIdParamSchema.safeParse(req.params);
    if (!params.success) return sendValidationError(res, 'Invalid keyId', params.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
    const body = FreezeBodySchema.safeParse(req.body);
    if (!body.success) return sendValidationError(res, 'Invalid body', body.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
    if (!req.adminId) return sendValidationError(res, 'Admin id missing');
    const status = await emergencyFreeze(params.data.keyId, body.data.reason, req.adminId);
    sendSuccess(res, status, 201, 'Key frozen');
  } catch (e) { next(e); }
};

export const httpInitiateUnfreeze: AsyncController = async (req: any, res, next) => {
  try {
    const params = KeyIdParamSchema.safeParse(req.params);
    if (!params.success) return sendValidationError(res, 'Invalid keyId', params.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
    const body = UnfreezeBodySchema.safeParse(req.body ?? {});
    if (!body.success) return sendValidationError(res, 'Invalid body', body.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
    if (!req.adminId) return sendValidationError(res, 'Admin id missing');
    const status = await initiateUnfreeze(params.data.keyId, req.adminId, body.data.reason);
    sendSuccess(res, status, 202, 'Unfreeze proposal created');
  } catch (e) { next(e); }
};
