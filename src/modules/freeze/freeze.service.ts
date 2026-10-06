// src/modules/freeze/freeze.service.ts
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { emitAuditEvent } from '../../utils/audit.utils';
import {
  invalidateFreezeCache,
  getCachedFreezeStatus,
  setCachedFreezeStatus,
} from '../../utils/freeze-cache.utils';

export interface FreezeStatus {
  keyId: string;
  isFrozen: boolean;
  reason: string | null;
  frozenAt: string | null;
  frozenBy: string | null;
  proposalId: string | null;
}

export async function getFreezeStatus(keyId: string): Promise<FreezeStatus> {
  const cached = getCachedFreezeStatus(keyId);
  if (cached) return cached;

  const row = await prisma.keyFreeze.findUnique({ where: { keyId } });
  const status: FreezeStatus = row
    ? {
        keyId: row.keyId,
        isFrozen: row.isFrozen,
        reason: row.reason,
        frozenAt: row.frozenAt ? row.frozenAt.toISOString() : null,
        frozenBy: row.frozenBy,
        proposalId: row.proposalId,
      }
    : { keyId, isFrozen: false, reason: null, frozenAt: null, frozenBy: null, proposalId: null };

  setCachedFreezeStatus(keyId, status);
  return status;
}

export async function emergencyFreeze(
  keyId: string,
  reason: string,
  adminId: string
): Promise<FreezeStatus> {
  const now = new Date();

  await prisma.keyFreeze.upsert({
    where: { keyId },
    create: { keyId, isFrozen: true, reason, frozenAt: now, frozenBy: adminId },
    update: { isFrozen: true, reason, frozenAt: now, frozenBy: adminId, unfrozenAt: null },
  });

  await prisma.freezeEvent.create({
    data: {
      keyId,
      eventType: 'FREEZE',
      ledger: BigInt(0),
      txHash: `admin:${adminId}:${now.getTime()}`,
      eventIndex: 0,
      payload: { reason, adminId },
    },
  });

  await emitAuditEvent({
    actor: adminId,
    action: 'emergency_freeze_key',
    target: 'KeyFreeze',
    targetId: keyId,
    metadata: { reason },
  });

  invalidateFreezeCache(keyId);
  logger.info({ keyId, adminId, reason }, 'freeze: emergency freeze executed');
  return getFreezeStatus(keyId);
}

export async function initiateUnfreeze(
  keyId: string,
  adminId: string,
  reason?: string
): Promise<FreezeStatus> {
  const now = new Date();
  const proposalId = `prop_${keyId}_${now.getTime()}`;

  await prisma.keyFreeze.upsert({
    where: { keyId },
    create: { keyId, isFrozen: false, reason: reason ?? null, proposalId, unfrozenAt: now, frozenBy: adminId },
    update: { proposalId, reason: reason ?? null, unfrozenAt: now },
  });

  await prisma.freezeEvent.create({
    data: {
      keyId,
      eventType: 'PROPOSAL_CREATED',
      ledger: BigInt(0),
      txHash: `proposal:${proposalId}`,
      eventIndex: 0,
      payload: { adminId, reason, proposalId },
    },
  });

  await emitAuditEvent({
    actor: adminId,
    action: 'initiate_unfreeze_proposal',
    target: 'KeyFreeze',
    targetId: keyId,
    metadata: { proposalId, reason: reason ?? null },
  });

  invalidateFreezeCache(keyId);
  logger.info({ keyId, adminId, proposalId }, 'freeze: unfreeze proposal initiated');
  return getFreezeStatus(keyId);
}

export async function indexFreezeEvent(input: {
  keyId: string;
  eventType: 'FREEZE' | 'UNFREEZE' | 'PROPOSAL_CREATED';
  ledger: number;
  txHash: string;
  eventIndex: number;
  payload: Record<string, unknown>;
}): Promise<void> {
  await prisma.freezeEvent.create({
    data: {
      keyId: input.keyId,
      eventType: input.eventType,
      ledger: BigInt(input.ledger),
      txHash: input.txHash,
      eventIndex: input.eventIndex,
      payload: input.payload as any,
    },
  });

  if (input.eventType === 'FREEZE') {
    await prisma.keyFreeze.upsert({
      where: { keyId: input.keyId },
      create: {
        keyId: input.keyId,
        isFrozen: true,
        reason: String(input.payload.reason ?? ''),
        frozenAt: new Date(),
      },
      update: {
        isFrozen: true,
        reason: String(input.payload.reason ?? ''),
        frozenAt: new Date(),
      },
    });
  } else if (input.eventType === 'UNFREEZE') {
    await prisma.keyFreeze.upsert({
      where: { keyId: input.keyId },
      create: { keyId: input.keyId, isFrozen: false, unfrozenAt: new Date() },
      update: { isFrozen: false, unfrozenAt: new Date() },
    });
  }

  invalidateFreezeCache(input.keyId);
}
