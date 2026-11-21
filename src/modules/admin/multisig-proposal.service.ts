// src/modules/admin/multisig-proposal.service.ts
// Multi-sig proposal queue for admin operations requiring multi-sig approval.
// Supports configurable threshold (default 2-of-3) with signature tracking.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
import { emitAuditEvent } from '../../utils/audit.utils';
import { createAuditEntry } from './audit-log.service';
import { Prisma } from '@prisma/client';

export const DEFAULT_MULTISIG_THRESHOLD = 2;
export const DEFAULT_MULTISIG_TOTAL_SIGNERS = 3;

export interface MultisigProposalInput {
  changeType: string;
  payload: Record<string, unknown>;
  threshold?: number;
  totalSigners?: number;
  proposedBy: string;
}

export interface MultisigProposalResult {
  id: string;
  proposalId: string;
  changeType: string;
  payload: Record<string, unknown>;
  status: string;
  threshold: number;
  totalSigners: number;
  proposedBy: string;
  proposedAt: Date;
  executedAt: Date | null;
  rejectedAt: Date | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  signatures: MultisigSignatureResult[];
  approvalCount: number;
}

export interface MultisigSignatureResult {
  id: string;
  proposalId: string;
  signer: string;
  signedAt: Date;
}

export interface SignProposalInput {
  proposalId: string;
  signer: string;
}

export interface SignProposalResult {
  proposalId: string;
  status: string;
  approvalCount: number;
  threshold: number;
  executed: boolean;
  signature: MultisigSignatureResult;
}

export interface RejectProposalInput {
  proposalId: string;
  rejector: string;
  reason?: string;
}

export interface RejectProposalResult {
  proposalId: string;
  status: string;
  rejectedAt: Date;
  rejectedBy: string;
  rejectionReason: string | null;
}

export class MultisigProposalNotFoundError extends Error {
  constructor(proposalId: string) {
    super(`Multisig proposal not found: ${proposalId}`);
    this.name = 'MultisigProposalNotFoundError';
  }
}

export class MultisigProposalInvalidStateError extends Error {
  constructor(proposalId: string, status: string, action: string) {
    super(`Cannot ${action} proposal ${proposalId}: invalid state ${status}`);
    this.name = 'MultisigProposalInvalidStateError';
  }
}

export class MultisigSignerNotAuthorizedError extends Error {
  constructor(signer: string) {
    super(`Signer ${signer} is not an authorized multisig admin`);
    this.name = 'MultisigSignerNotAuthorizedError';
  }
}

export class MultisigDuplicateSignatureError extends Error {
  constructor(proposalId: string, signer: string) {
    super(`Signer ${signer} has already signed proposal ${proposalId}`);
    this.name = 'MultisigDuplicateSignatureError';
  }
}

export class MultisigThresholdNotMetError extends Error {
  constructor(proposalId: string, current: number, required: number) {
    super(`Threshold not met for proposal ${proposalId}: ${current}/${required}`);
    this.name = 'MultisigThresholdNotMetError';
  }
}

const STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;

function parseMultisigAdminWallets(): string[] {
  const raw = envConfig.ADMIN_MULTISIG_WALLETS;
  if (!raw) return [];
  return raw
    .split(',')
    .map(wallet => wallet.trim())
    .filter(wallet => wallet.length > 0);
}

function isAuthorizedSigner(signer: string): boolean {
  const adminWallets = parseMultisigAdminWallets();
  if (adminWallets.length === 0) {
    // In development, any valid Stellar address is allowed if no quorum is configured
    return STELLAR_ADDRESS_PATTERN.test(signer);
  }
  const adminSet = new Set(adminWallets.map(w => w.toLowerCase()));
  return adminSet.has(signer.toLowerCase());
}

function validateStellarAddress(address: string): boolean {
  return STELLAR_ADDRESS_PATTERN.test(address);
}

export async function createMultisigProposal(
  input: MultisigProposalInput
): Promise<MultisigProposalResult> {
  const threshold = input.threshold ?? DEFAULT_MULTISIG_THRESHOLD;
  const totalSigners = input.totalSigners ?? DEFAULT_MULTISIG_TOTAL_SIGNERS;

  if (threshold < 1 || threshold > totalSigners) {
    throw new Error('Invalid threshold: must be between 1 and totalSigners');
  }

  if (totalSigners < 1) {
    throw new Error('Invalid totalSigners: must be at least 1');
  }

  if (!validateStellarAddress(input.proposedBy)) {
    throw new Error('Invalid proposer address');
  }

  const proposalId = `msig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const proposal = await prisma.multisigProposal.create({
    data: {
      proposalId,
      changeType: input.changeType,
      payload: input.payload,
      threshold,
      totalSigners,
      proposedBy: input.proposedBy,
      status: 'pending',
    },
  });

  await emitAuditEvent({
    actor: input.proposedBy,
    action: 'multisig_proposal_created',
    target: 'MultisigProposal',
    targetId: proposalId,
    metadata: {
      proposalId,
      changeType: input.changeType,
      payload: input.payload,
      threshold,
      totalSigners,
    },
  });

  await createAuditEntry({
    actorWallet: input.proposedBy,
    actionType: 'multisig_proposal_created',
    targetId: proposalId,
    payload: {
      proposalId,
      changeType: input.changeType,
      payload: input.payload,
      threshold,
      totalSigners,
    },
  });

  logger.info(
    {
      proposalId,
      changeType: input.changeType,
      threshold,
      totalSigners,
      proposedBy: input.proposedBy,
    },
    'Multisig proposal created'
  );

  return serializeProposal(proposal, []);
}

export async function getMultisigProposalQueue(params: {
  status?: string;
  page?: number;
  limit?: number;
}): Promise<{
  items: MultisigProposalResult[];
  meta: {
    page: number;
    limit: number;
    totalCount: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
}> {
  const { status, page = 1, limit = 20 } = params;
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(100, Math.max(1, limit));
  const skip = (safePage - 1) * safeLimit;

  const where: Record<string, unknown> = {};
  if (status) {
    where.status = status;
  }

  const [proposals, totalCount] = await Promise.all([
    prisma.multisigProposal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: safeLimit,
      include: {
        signatures: {
          orderBy: { signedAt: 'asc' },
        },
      },
    }),
    prisma.multisigProposal.count({ where }),
  ]);

  const items = proposals.map(p => serializeProposal(p, p.signatures));

  const totalPages = Math.ceil(totalCount / safeLimit);

  return {
    items,
    meta: {
      page: safePage,
      limit: safeLimit,
      totalCount,
      totalPages,
      hasNextPage: safePage < totalPages,
      hasPrevPage: safePage > 1,
    },
  };
}

export async function getMultisigProposalById(
  proposalId: string
): Promise<MultisigProposalResult> {
  const proposal = await prisma.multisigProposal.findUnique({
    where: { proposalId },
    include: {
      signatures: {
        orderBy: { signedAt: 'asc' },
      },
    },
  });

  if (!proposal) {
    throw new MultisigProposalNotFoundError(proposalId);
  }

  return serializeProposal(proposal, proposal.signatures);
}

export async function signMultisigProposal(
  input: SignProposalInput
): Promise<SignProposalResult> {
  const { proposalId, signer } = input;

  if (!validateStellarAddress(signer)) {
    throw new Error('Invalid signer address');
  }

  if (!isAuthorizedSigner(signer)) {
    throw new MultisigSignerNotAuthorizedError(signer);
  }

  return prisma.$transaction(async tx => {
    const proposal = await tx.multisigProposal.findUnique({
      where: { proposalId },
      include: { signatures: true },
    });

    if (!proposal) {
      throw new MultisigProposalNotFoundError(proposalId);
    }

    if (proposal.status !== 'pending') {
      throw new MultisigProposalInvalidStateError(proposalId, proposal.status, 'sign');
    }

    const existingSignature = proposal.signatures.find(
      s => s.signer.toLowerCase() === signer.toLowerCase()
    );
    if (existingSignature) {
      throw new MultisigDuplicateSignatureError(proposalId, signer);
    }

    const signature = await tx.multisigSignature.create({
      data: {
        proposalId,
        signer,
      },
    });

    const approvalCount = proposal.signatures.length + 1;
    const thresholdMet = approvalCount >= proposal.threshold;

    let updatedProposal = proposal;
    let executed = false;

    if (thresholdMet) {
      updatedProposal = await tx.multisigProposal.update({
        where: { proposalId },
        data: {
          status: 'executed',
          executedAt: new Date(),
        },
        include: { signatures: true },
      });
      executed = true;

      await executeProposal(updatedProposal, signer);

      await emitAuditEvent({
        actor: signer,
        action: 'multisig_proposal_executed',
        target: 'MultisigProposal',
        targetId: proposalId,
        metadata: {
          proposalId,
          changeType: proposal.changeType,
          payload: proposal.payload,
          finalSigner: signer,
          approvalCount,
          threshold: proposal.threshold,
        },
      });

      await createAuditEntry({
        actorWallet: signer,
        actionType: 'multisig_proposal_executed',
        targetId: proposalId,
        payload: {
          proposalId,
          changeType: proposal.changeType,
          payload: proposal.payload,
          finalSigner: signer,
          approvalCount,
          threshold: proposal.threshold,
        },
      });
    } else {
      await emitAuditEvent({
        actor: signer,
        action: 'multisig_proposal_signed',
        target: 'MultisigProposal',
        targetId: proposalId,
        metadata: {
          proposalId,
          signer,
          approvalCount,
          threshold: proposal.threshold,
        },
      });

      await createAuditEntry({
        actorWallet: signer,
        actionType: 'multisig_proposal_signed',
        targetId: proposalId,
        payload: {
          proposalId,
          signer,
          approvalCount,
          threshold: proposal.threshold,
        },
      });
    }

    logger.info(
      {
        proposalId,
        signer,
        approvalCount,
        threshold: proposal.threshold,
        executed,
      },
      executed ? 'Multisig proposal executed' : 'Multisig proposal signed'
    );

    return {
      proposalId,
      status: updatedProposal.status,
      approvalCount,
      threshold: proposal.threshold,
      executed,
      signature: {
        id: signature.id,
        proposalId: signature.proposalId,
        signer: signature.signer,
        signedAt: signature.signedAt,
      },
    };
  });
}

export async function rejectMultisigProposal(
  input: RejectProposalInput
): Promise<RejectProposalResult> {
  const { proposalId, rejector, reason } = input;

  if (!validateStellarAddress(rejector)) {
    throw new Error('Invalid rejector address');
  }

  if (!isAuthorizedSigner(rejector)) {
    throw new MultisigSignerNotAuthorizedError(rejector);
  }

  return prisma.$transaction(async tx => {
    const proposal = await tx.multisigProposal.findUnique({
      where: { proposalId },
    });

    if (!proposal) {
      throw new MultisigProposalNotFoundError(proposalId);
    }

    if (proposal.status !== 'pending') {
      throw new MultisigProposalInvalidStateError(proposalId, proposal.status, 'reject');
    }

    const rejectedAt = new Date();

    const updatedProposal = await tx.multisigProposal.update({
      where: { proposalId },
      data: {
        status: 'rejected',
        rejectedAt,
        rejectedBy: rejector,
        rejectionReason: reason ?? null,
      },
    });

    await emitAuditEvent({
      actor: rejector,
      action: 'multisig_proposal_rejected',
      target: 'MultisigProposal',
      targetId: proposalId,
      metadata: {
        proposalId,
        changeType: proposal.changeType,
        payload: proposal.payload,
        rejectedBy: rejector,
        reason: reason ?? null,
      },
    });

    await createAuditEntry({
      actorWallet: rejector,
      actionType: 'multisig_proposal_rejected',
      targetId: proposalId,
      payload: {
        proposalId,
        changeType: proposal.changeType,
        payload: proposal.payload,
        rejectedBy: rejector,
        reason: reason ?? null,
      },
    });

    logger.info(
      {
        proposalId,
        rejector,
        reason: reason ?? null,
      },
      'Multisig proposal rejected'
    );

    return {
      proposalId,
      status: updatedProposal.status,
      rejectedAt,
      rejectedBy: rejector,
      rejectionReason: reason ?? null,
    };
  });
}

async function executeProposal(
  proposal: {
    proposalId: string;
    changeType: string;
    payload: Prisma.JsonValue;
  },
  _executor: string
): Promise<void> {
  logger.info(
    {
      proposalId: proposal.proposalId,
      changeType: proposal.changeType,
      payload: proposal.payload,
    },
    'Executing multisig proposal (placeholder - implement actual execution logic)'
  );

  // TODO: Implement actual execution logic based on changeType
  // This would typically interact with the Stellar network via Soroban SDK
  // to submit the transaction corresponding to the changeType and payload.
  // For now, we just log the execution.
}

function serializeProposal(
  proposal: {
    id: string;
    proposalId: string;
    changeType: string;
    payload: Prisma.JsonValue;
    status: string;
    threshold: number;
    totalSigners: number;
    proposedBy: string;
    proposedAt: Date;
    executedAt: Date | null;
    rejectedAt: Date | null;
    rejectedBy: string | null;
    rejectionReason: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  signatures: {
    id: string;
    proposalId: string;
    signer: string;
    signedAt: Date;
  }[]
): MultisigProposalResult {
  return {
    id: proposal.id,
    proposalId: proposal.proposalId,
    changeType: proposal.changeType,
    payload: (proposal.payload as Record<string, unknown>) ?? {},
    status: proposal.status,
    threshold: proposal.threshold,
    totalSigners: proposal.totalSigners,
    proposedBy: proposal.proposedBy,
    proposedAt: proposal.proposedAt,
    executedAt: proposal.executedAt,
    rejectedAt: proposal.rejectedAt,
    rejectedBy: proposal.rejectedBy,
    rejectionReason: proposal.rejectionReason,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    signatures: signatures.map(s => ({
      id: s.id,
      proposalId: s.proposalId,
      signer: s.signer,
      signedAt: s.signedAt,
    })),
    approvalCount: signatures.length,
  };
}