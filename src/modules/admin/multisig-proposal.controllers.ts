// src/modules/admin/multisig-proposal.controllers.ts
import { AsyncController } from '../../types/auth.types';
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { AdminRequest } from '../../middlewares/admin-guard.middleware';
import {
  sendSuccess,
  sendValidationError,
  sendNotFound,
  sendForbidden,
  sendError,
  sendConflict,
  zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import {
  createMultisigProposal,
  getMultisigProposalQueue,
  getMultisigProposalById,
  signMultisigProposal,
  rejectMultisigProposal,
  MultisigProposalNotFoundError,
  MultisigProposalInvalidStateError,
  MultisigSignerNotAuthorizedError,
  MultisigDuplicateSignatureError,
} from './multisig-proposal.service';
import { logger } from '../../utils/logger.utils';

const STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;

const createProposalSchema = z.object({
  changeType: z.string().min(1, 'changeType is required'),
  payload: z.record(z.unknown()),
  threshold: z.number().int().positive().optional(),
  totalSigners: z.number().int().positive().optional(),
});

const signProposalSchema = z.object({
  signer: z.string().regex(STELLAR_ADDRESS_PATTERN, 'Invalid Stellar address'),
});

const rejectProposalSchema = z.object({
  rejector: z.string().regex(STELLAR_ADDRESS_PATTERN, 'Invalid Stellar address'),
  reason: z.string().optional(),
});

const queueQuerySchema = z.object({
  status: z.enum(['pending', 'executed', 'rejected']).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

export const httpCreateMultisigProposal: AsyncController = async (
  req: AdminRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = createProposalSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, 'Invalid request body', zodIssuesToDetails(parsed.error.issues));
      return;
    }

    const adminId = req.adminId || 'unknown';
    const result = await createMultisigProposal({
      ...parsed.data,
      proposedBy: adminId,
    });

    sendSuccess(res, result, 201);
  } catch (error) {
    logger.error({ error }, 'Create multisig proposal failed');
    next(error);
  }
};

export const httpGetMultisigProposalQueue: AsyncController = async (
  req: AdminRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = queueQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, 'Invalid query parameters', zodIssuesToDetails(parsed.error.issues));
      return;
    }

    const result = await getMultisigProposalQueue(parsed.data);
    sendSuccess(res, result);
  } catch (error) {
    logger.error({ error }, 'Get multisig proposal queue failed');
    next(error);
  }
};

export const httpGetMultisigProposalById: AsyncController = async (
  req: AdminRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const proposalId = String(req.params.id);
    const result = await getMultisigProposalById(proposalId);
    sendSuccess(res, result);
  } catch (error) {
    if (error instanceof MultisigProposalNotFoundError) {
      sendNotFound(res, 'Multisig proposal');
      return;
    }
    logger.error({ error, proposalId: req.params.id }, 'Get multisig proposal by ID failed');
    next(error);
  }
};

export const httpSignMultisigProposal: AsyncController = async (
  req: AdminRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const proposalId = String(req.params.id);
    const parsed = signProposalSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, 'Invalid request body', zodIssuesToDetails(parsed.error.issues));
      return;
    }

    const result = await signMultisigProposal({
      proposalId,
      signer: parsed.data.signer,
    });

    sendSuccess(res, result);
  } catch (error) {
    if (error instanceof MultisigProposalNotFoundError) {
      sendNotFound(res, 'Multisig proposal');
      return;
    }
    if (error instanceof MultisigProposalInvalidStateError) {
      sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
      return;
    }
    if (error instanceof MultisigSignerNotAuthorizedError) {
      sendForbidden(res, error.message);
      return;
    }
    if (error instanceof MultisigDuplicateSignatureError) {
      sendConflict(res, error.message);
      return;
    }
    logger.error({ error, proposalId: req.params.id }, 'Sign multisig proposal failed');
    next(error);
  }
};

export const httpRejectMultisigProposal: AsyncController = async (
  req: AdminRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const proposalId = String(req.params.id);
    const parsed = rejectProposalSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, 'Invalid request body', zodIssuesToDetails(parsed.error.issues));
      return;
    }

    const result = await rejectMultisigProposal({
      proposalId,
      rejector: parsed.data.rejector,
      reason: parsed.data.reason,
    });

    sendSuccess(res, result);
  } catch (error) {
    if (error instanceof MultisigProposalNotFoundError) {
      sendNotFound(res, 'Multisig proposal');
      return;
    }
    if (error instanceof MultisigProposalInvalidStateError) {
      sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
      return;
    }
    if (error instanceof MultisigSignerNotAuthorizedError) {
      sendForbidden(res, error.message);
      return;
    }
    logger.error({ error, proposalId: req.params.id }, 'Reject multisig proposal failed');
    next(error);
  }
};