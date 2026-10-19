import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';

export class ActionNotFoundError extends Error {
   constructor(actionId: string) {
      super(`Multisig action not found: ${actionId}`);
      this.name = 'ActionNotFoundError';
   }
}

export class IneligibleSignerError extends Error {
   constructor(signer: string) {
      super(`Signer not eligible for multisig action: ${signer}`);
      this.name = 'IneligibleSignerError';
   }
}

export interface MultisigActionSignatureItem {
   signer: string;
   signedAt: string;
   txHash: string | null;
}

export interface MultisigActionPendingItem {
   action_id: string;
   description: string | null;
   target: string | null;
   function_name: string | null;
   status: string;
   signature_count: number;
   threshold: number;
   total_signers: number;
   proposed_by: string;
   proposed_at: string;
}

export interface MultisigActionDetailItem {
   action_id: string;
   description: string | null;
   target: string | null;
   function_name: string | null;
   params: Record<string, unknown> | null;
   status: string;
   signature_count: number;
   threshold: number;
   total_signers: number;
   proposed_by: string;
   proposed_at: string;
   executed_at: string | null;
   expired_at: string | null;
   outcome: string | null;
   tx_hash: string | null;
   signers: MultisigActionSignatureItem[];
}

export interface MultisigActionHistoryItem {
   action_id: string;
   description: string | null;
   target: string | null;
   function_name: string | null;
   status: string;
   outcome: string | null;
   signature_count: number;
   threshold: number;
   proposed_by: string;
   proposed_at: string;
   executed_at: string | null;
   expired_at: string | null;
}

/**
 * Checks if a wallet is in the eligible signer set.
 */
export function isEligibleSigner(signer: string, eligibleSigners?: string[]): boolean {
   const configuredSigners = eligibleSigners ?? (envConfig as any).MULTISIG_SIGNERS;
   if (!configuredSigners || (Array.isArray(configuredSigners) && configuredSigners.length === 0)) {
      return true; // No restriction configured
   }
   const allowed = Array.isArray(configuredSigners)
      ? configuredSigners
      : String(configuredSigners).split(',').map((s: string) => s.trim());
   return allowed.includes(signer);
}

/**
 * Returns list of pending multisig actions with signature count and threshold (#1085).
 */
export async function getPendingMultisigActions(): Promise<MultisigActionPendingItem[]> {
   const actions = await (prisma as any).multisigAction.findMany({
      where: { status: 'pending' },
      include: {
         signatures: {
            select: { signer: true },
         },
      },
      orderBy: { proposedAt: 'desc' },
   });

   return actions.map((a: any) => ({
      action_id: a.actionId,
      description: a.description,
      target: a.target,
      function_name: a.functionName,
      status: a.status,
      signature_count: a.signatures.length,
      threshold: a.threshold,
      total_signers: a.totalSigners,
      proposed_by: a.proposedBy,
      proposed_at: a.proposedAt ? new Date(a.proposedAt).toISOString() : new Date().toISOString(),
   }));
}

/**
 * Returns detail of a single multisig action with signer list and params (#1085).
 */
export async function getMultisigActionDetail(
   actionId: string
): Promise<MultisigActionDetailItem> {
   const action = await (prisma as any).multisigAction.findUnique({
      where: { actionId },
      include: {
         signatures: {
            orderBy: { signedAt: 'asc' },
         },
      },
   });

   if (!action) {
      throw new ActionNotFoundError(actionId);
   }

   return {
      action_id: action.actionId,
      description: action.description,
      target: action.target,
      function_name: action.functionName,
      params: action.params as Record<string, unknown> | null,
      status: action.status,
      signature_count: action.signatures.length,
      threshold: action.threshold,
      total_signers: action.totalSigners,
      proposed_by: action.proposedBy,
      proposed_at: action.proposedAt ? new Date(action.proposedAt).toISOString() : new Date().toISOString(),
      executed_at: action.executedAt ? new Date(action.executedAt).toISOString() : null,
      expired_at: action.expiredAt ? new Date(action.expiredAt).toISOString() : null,
      outcome: action.outcome,
      tx_hash: action.txHash,
      signers: action.signatures.map((s: any) => ({
         signer: s.signer,
         signedAt: s.signedAt ? new Date(s.signedAt).toISOString() : new Date().toISOString(),
         txHash: s.txHash ?? null,
      })),
   };
}

/**
 * Returns history of completed and expired multisig actions with outcomes (#1085).
 */
export async function getMultisigActionHistory(): Promise<MultisigActionHistoryItem[]> {
   const actions = await (prisma as any).multisigAction.findMany({
      where: {
         status: { in: ['executed', 'rejected', 'expired'] },
      },
      include: {
         signatures: {
            select: { signer: true },
         },
      },
      orderBy: { updatedAt: 'desc' },
   });

   return actions.map((a: any) => ({
      action_id: a.actionId,
      description: a.description,
      target: a.target,
      function_name: a.functionName,
      status: a.status,
      outcome: a.outcome,
      signature_count: a.signatures.length,
      threshold: a.threshold,
      proposed_by: a.proposedBy,
      proposed_at: a.proposedAt ? new Date(a.proposedAt).toISOString() : new Date().toISOString(),
      executed_at: a.executedAt ? new Date(a.executedAt).toISOString() : null,
      expired_at: a.expiredAt ? new Date(a.expiredAt).toISOString() : null,
   }));
}
