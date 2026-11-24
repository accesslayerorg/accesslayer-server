// src/modules/admin/impersonation.service.ts
// Read-only "view as" sessions for support staff (#1342).
//
// A session row is the source of truth. The impersonation JWT carries the row
// id, and impersonationGuard checks the row on every request, so ending a
// session takes effect immediately. The token authenticates as the target
// wallet, which lets support see exactly what that user sees.

import jwt from 'jsonwebtoken';
import { envConfig } from '../../config';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { SendMail } from '../../utils/mail.utils';
import { createAuditEntry } from './audit-log.service';

/** Session lifetime. Enforced by the token expiry and the session row. */
export const IMPERSONATION_TTL_SECONDS = 15 * 60;

/** A second factor must have been verified within this window to start. */
export const IMPERSONATION_MFA_MAX_AGE_SECONDS = 5 * 60;

/** Claim name on the impersonation JWT. */
export const IMPERSONATION_CLAIM = 'impersonation';

export interface ImpersonationClaim {
   sessionId: string;
   adminId: string;
   readOnly: true;
}

export class ImpersonationMfaRequiredError extends Error {
   constructor() {
      super('Fresh second-factor verification is required to start an impersonation session');
      this.name = 'ImpersonationMfaRequiredError';
   }
}

export class ImpersonationTargetNotFoundError extends Error {
   constructor() {
      super('No user is linked to that wallet address');
      this.name = 'ImpersonationTargetNotFoundError';
   }
}

/**
 * True when the admin's second factor was verified recently enough. `mfaAt`
 * is the `mfa_at` claim in epoch seconds, supplied by the identity provider
 * after a second-factor challenge.
 */
export function isMfaFresh(mfaAt: number | undefined, now: Date = new Date()): boolean {
   if (typeof mfaAt !== 'number' || !Number.isFinite(mfaAt)) return false;
   const nowSeconds = Math.floor(now.getTime() / 1000);
   const age = nowSeconds - mfaAt;
   // Reject timestamps from the future beyond a small clock-skew allowance.
   return age >= -60 && age <= IMPERSONATION_MFA_MAX_AGE_SECONDS;
}

/** Read the impersonation claim from verified JWT claims, if present. */
export function readImpersonationClaim(
   claims: jwt.JwtPayload
): ImpersonationClaim | null {
   const claim = claims[IMPERSONATION_CLAIM] as Partial<ImpersonationClaim> | undefined;
   if (
      !claim ||
      typeof claim.sessionId !== 'string' ||
      typeof claim.adminId !== 'string' ||
      claim.readOnly !== true
   ) {
      return null;
   }
   return { sessionId: claim.sessionId, adminId: claim.adminId, readOnly: true };
}

function signImpersonationToken(params: {
   wallet: string;
   sessionId: string;
   adminId: string;
}): string {
   return jwt.sign(
      {
         wallet: params.wallet,
         [IMPERSONATION_CLAIM]: {
            sessionId: params.sessionId,
            adminId: params.adminId,
            readOnly: true,
         },
      },
      envConfig.JWT_SECRET,
      {
         subject: params.wallet,
         issuer: envConfig.JWT_ISSUER,
         expiresIn: IMPERSONATION_TTL_SECONDS,
         jwtid: params.sessionId,
      }
   );
}

export interface StartImpersonationInput {
   adminId: string;
   walletAddress: string;
   reason: string;
   /** The admin token's `mfa_at` claim, if any. */
   adminMfaAt?: number;
   now?: Date;
}

export interface StartedImpersonation {
   sessionId: string;
   token: string;
   targetWallet: string;
   expiresAt: string;
   readOnly: true;
}

/**
 * Start a read-only session for the user behind `walletAddress`.
 *
 * @throws ImpersonationMfaRequiredError when the second factor is not fresh.
 * @throws ImpersonationTargetNotFoundError when no user owns the wallet.
 */
export async function startImpersonation(
   input: StartImpersonationInput
): Promise<StartedImpersonation> {
   const now = input.now ?? new Date();
   if (!isMfaFresh(input.adminMfaAt, now)) {
      throw new ImpersonationMfaRequiredError();
   }

   const wallet = await prisma.stellarWallet.findUnique({
      where: { address: input.walletAddress },
      select: { address: true, userId: true },
   });
   if (!wallet) {
      throw new ImpersonationTargetNotFoundError();
   }

   const expiresAt = new Date(now.getTime() + IMPERSONATION_TTL_SECONDS * 1000);
   const session = await prisma.impersonationSession.create({
      data: {
         adminId: input.adminId,
         targetUserId: wallet.userId,
         targetWallet: wallet.address,
         reason: input.reason,
         expiresAt,
      },
   });

   await createAuditEntry({
      actorWallet: input.adminId,
      actionType: 'impersonation_started',
      targetId: session.id,
      payload: {
         targetWallet: wallet.address,
         targetUserId: wallet.userId,
         reason: input.reason,
         expiresAt: expiresAt.toISOString(),
      },
   });

   return {
      sessionId: session.id,
      token: signImpersonationToken({
         wallet: wallet.address,
         sessionId: session.id,
         adminId: input.adminId,
      }),
      targetWallet: wallet.address,
      expiresAt: expiresAt.toISOString(),
      readOnly: true,
   };
}

/** Email the user whose account was viewed. Failures are logged, not thrown. */
async function notifyTargetUser(targetWallet: string): Promise<void> {
   try {
      const wallet = await prisma.stellarWallet.findUnique({
         where: { address: targetWallet },
         select: { user: { select: { email: true, firstName: true } } },
      });
      if (!wallet?.user.email) return;

      await SendMail({
         to: wallet.user.email,
         subject: 'Access Layer support viewed your account',
         text: `Hi ${wallet.user.firstName || 'there'}, a member of the Access Layer support team viewed your account in read-only mode to help with a support request. No changes were made. If you did not expect this, please contact us.`,
      });
   } catch (error) {
      logger.error(
         { error, targetWallet },
         'Failed to send impersonation notification'
      );
   }
}

export type EndImpersonationOutcome = 'ENDED' | 'NOT_FOUND' | 'ALREADY_ENDED';

/** End a session on an admin's request. Takes effect on the next request. */
export async function endImpersonation(input: {
   sessionId: string;
   adminId: string;
   reason?: string;
   now?: Date;
}): Promise<EndImpersonationOutcome> {
   const now = input.now ?? new Date();
   const session = await prisma.impersonationSession.findUnique({
      where: { id: input.sessionId },
   });
   if (!session) return 'NOT_FOUND';
   if (session.endedAt) return 'ALREADY_ENDED';

   const closed = await prisma.impersonationSession.updateMany({
      where: { id: session.id, endedAt: null },
      data: { endedAt: now, endReason: 'ADMIN_ENDED' },
   });
   if (closed.count === 0) return 'ALREADY_ENDED';

   await createAuditEntry({
      actorWallet: input.adminId,
      actionType: 'impersonation_ended',
      targetId: session.id,
      payload: {
         endReason: 'ADMIN_ENDED',
         targetWallet: session.targetWallet,
         requestCount: session.requestCount,
         adminNote: input.reason ?? null,
      },
   });
   await notifyTargetUser(session.targetWallet);
   return 'ENDED';
}

/**
 * Close a session whose token has expired. Called by the guard when an
 * expired (but correctly signed) impersonation token is presented, so the
 * session is closed and the user is notified once.
 */
export async function closeExpiredImpersonation(sessionId: string): Promise<void> {
   const session = await prisma.impersonationSession.findUnique({
      where: { id: sessionId },
   });
   if (!session || session.endedAt) return;

   const closed = await prisma.impersonationSession.updateMany({
      where: { id: session.id, endedAt: null },
      data: { endedAt: new Date(), endReason: 'EXPIRED' },
   });
   if (closed.count === 0) return;

   await createAuditEntry({
      actorWallet: session.adminId,
      actionType: 'impersonation_ended',
      targetId: session.id,
      payload: {
         endReason: 'EXPIRED',
         targetWallet: session.targetWallet,
         requestCount: session.requestCount,
      },
   });
   await notifyTargetUser(session.targetWallet);
}
