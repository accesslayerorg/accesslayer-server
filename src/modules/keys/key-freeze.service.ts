// src/modules/keys/key-freeze.service.ts
// Self-custody freeze mechanism for creator key holders (#885).
//
// A holder freezes their own position to prevent transfers and trades until
// they explicitly unfreeze. Buy, sell, transfer, and multi-buy paths call
// `assertPositionNotFrozen` before executing. Freeze state is exposed on
// position/holdings responses, and every freeze/unfreeze is written to the
// audit log.

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { emitAuditEvent } from '../../utils/audit.utils';
import { createAuditEntry } from '../admin/audit-log.service';
import { KeyNotFoundError } from './key-fees.service';

export class PositionFrozenError extends Error {
   constructor(public readonly keyId: string) {
      super('Position is frozen — trading and transfers are disabled until unfrozen');
      this.name = 'PositionFrozenError';
   }
}

export class PositionNotFoundError extends Error {
   constructor(public readonly keyId: string) {
      super(`No key position found for key: ${keyId}`);
      this.name = 'PositionNotFoundError';
   }
}

export class PositionAlreadyFrozenError extends Error {
   constructor(public readonly keyId: string) {
      super('Position is already frozen');
      this.name = 'PositionAlreadyFrozenError';
   }
}

export class PositionNotFrozenError extends Error {
   constructor(public readonly keyId: string) {
      super('Position is not frozen');
      this.name = 'PositionNotFrozenError';
   }
}

/**
 * Throw when the wallet's position on `keyId` is frozen. Positions that do
 * not exist are treated as unfrozen so first-time buys are unaffected.
 */
export async function assertPositionNotFrozen(
   walletAddress: string,
   keyId: string
): Promise<void> {
   const ownership = await prisma.keyOwnership.findUnique({
      where: {
         ownerAddress_creatorId: {
            ownerAddress: walletAddress,
            creatorId: keyId,
         },
      },
      select: { frozen: true },
   });
   if (ownership?.frozen) {
      throw new PositionFrozenError(keyId);
   }
}

async function auditFreezeEvent(params: {
   wallet: string;
   keyId: string;
   action: 'position_frozen' | 'position_unfrozen';
   metadata: Record<string, unknown>;
}): Promise<void> {
   await emitAuditEvent({
      actor: params.wallet,
      action: params.action,
      target: 'KeyOwnership',
      targetId: `${params.keyId}:${params.wallet}`,
      metadata: { keyId: params.keyId, wallet: params.wallet, ...params.metadata },
   });
   await createAuditEntry({
      actorWallet: params.wallet,
      actionType: params.action,
      targetId: params.keyId,
      payload: { keyId: params.keyId, wallet: params.wallet, ...params.metadata },
   });
}

/**
 * Freeze the authenticated wallet's position on a key. Requires an existing
 * ownership record; records the freeze event in the audit log.
 */
export async function freezePosition(
   keyId: string,
   walletAddress: string
): Promise<{ keyId: string; wallet: string; frozen: true; frozenAt: Date }> {
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true },
   });
   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const ownership = await prisma.keyOwnership.findUnique({
      where: {
         ownerAddress_creatorId: {
            ownerAddress: walletAddress,
            creatorId: creator.id,
         },
      },
      select: { id: true, frozen: true },
   });
   if (!ownership) {
      throw new PositionNotFoundError(creator.id);
   }
   if (ownership.frozen) {
      throw new PositionAlreadyFrozenError(creator.id);
   }

   const frozenAt = new Date();
   await prisma.keyOwnership.update({
      where: { id: ownership.id },
      data: { frozen: true, frozenAt },
   });

   await auditFreezeEvent({
      wallet: walletAddress,
      keyId: creator.id,
      action: 'position_frozen',
      metadata: { frozenAt: frozenAt.toISOString() },
   });

   return { keyId: creator.id, wallet: walletAddress, frozen: true, frozenAt };
}

/**
 * Unfreeze a previously frozen position, restoring trading and transfers.
 */
export async function unfreezePosition(
   keyId: string,
   walletAddress: string
): Promise<{ keyId: string; wallet: string; frozen: false }> {
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true },
   });
   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const ownership = await prisma.keyOwnership.findUnique({
      where: {
         ownerAddress_creatorId: {
            ownerAddress: walletAddress,
            creatorId: creator.id,
         },
      },
      select: { id: true, frozen: true },
   });
   if (!ownership) {
      throw new PositionNotFoundError(creator.id);
   }
   if (!ownership.frozen) {
      throw new PositionNotFrozenError(creator.id);
   }

   await prisma.keyOwnership.update({
      where: { id: ownership.id },
      data: { frozen: false, frozenAt: null },
   });

   await auditFreezeEvent({
      wallet: walletAddress,
      keyId: creator.id,
      action: 'position_unfrozen',
      metadata: { unfrozenAt: new Date().toISOString() },
   });

   return { keyId: creator.id, wallet: walletAddress, frozen: false };
}

const FREEZE_STATUS_CACHE_TTL_SECONDS = 30;

export interface FreezeStatus {
   keyId: string;
   wallet: string;
   frozenQuantity: number;
   liquidQuantity: number;
}

/**
 * Frozen and liquid balance for a holder on a key (#871). A frozen position
 * locks the whole balance; a wallet with no position or no freeze has a
 * frozenQuantity of 0. Cached per (keyId, wallet) for 30 seconds.
 */
export async function getFreezeStatus(
   keyId: string,
   walletAddress: string
): Promise<FreezeStatus> {
   const cacheKey = `keys:freeze-status:${keyId}:${walletAddress}`;
   const cached = await cacheGetJson<FreezeStatus>(cacheKey);
   if (cached) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true },
   });
   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const ownership = await prisma.keyOwnership.findUnique({
      where: {
         ownerAddress_creatorId: {
            ownerAddress: walletAddress,
            creatorId: creator.id,
         },
      },
      select: { balance: true, frozen: true },
   });

   const totalBalance = Number(ownership?.balance ?? 0);
   const frozenQuantity = ownership?.frozen ? totalBalance : 0;
   const status: FreezeStatus = {
      keyId: creator.id,
      wallet: walletAddress,
      frozenQuantity,
      liquidQuantity: totalBalance - frozenQuantity,
   };

   await cacheSetJson(cacheKey, status, FREEZE_STATUS_CACHE_TTL_SECONDS);
   return status;
}
