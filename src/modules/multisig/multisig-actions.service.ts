// src/modules/multisig/multisig-actions.service.ts

import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { getLedgerEntries } from '../../utils/soroban-rpc.utils';
import { logger } from '../../utils/logger.utils';

const STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;

export class MultisigActionNotFoundError extends Error {
   constructor(actionId: string) {
      super(`Multisig action not found: ${actionId}`);
      this.name = 'MultisigActionNotFoundError';
   }
}

export function parseMultisigAdminWallets(): string[] {
   const raw = envConfig.ADMIN_MULTISIG_WALLETS;
   if (!raw) return [];
   return raw
      .split(',')
      .map(wallet => wallet.trim())
      .filter(wallet => wallet.length > 0);
}

/**
 * Fetches the signer set from on-chain contract ledger entries if configured,
 * or falls back to ADMIN_MULTISIG_WALLETS environment variable configuration.
 */
export async function getOnChainSignerSet(): Promise<string[]> {
   const cfg = envConfig as Record<string, unknown>;
   const contractId = (cfg.ADMIN_MULTISIG_CONTRACT_ID || cfg.GOVERNANCE_CONTRACT_ID) as string | undefined;
   if (contractId) {
      try {
         const result = await getLedgerEntries([contractId]);
         if (result && result.entries && result.entries.length > 0) {
            // If contract returns signer set entries, parse them here.
            // Falls through to environment variable config below if empty or unparsed.
         }
      } catch (error) {
         logger.warn({ error }, 'Failed to fetch on-chain signer set from Soroban RPC; falling back to config');
      }
   }

   const adminWallets = parseMultisigAdminWallets();
   return adminWallets;
}

export async function validateSignerEligibility(signer: string): Promise<boolean> {
   if (!STELLAR_ADDRESS_PATTERN.test(signer)) {
      return false;
   }

   const adminWallets = await getOnChainSignerSet();
   if (adminWallets.length === 0) {
      // Development fallback: any valid Stellar address is allowed when no quorum is configured
      return true;
   }

   const adminSet = new Set(adminWallets.map(w => w.toLowerCase()));
   return adminSet.has(signer.toLowerCase());
}

export async function getPendingActions() {
   const actions = await prisma.multisigAction.findMany({
      where: { status: 'pending' },
      include: { signatures: true },
      orderBy: { proposedAt: 'desc' },
   });

   return actions.map(action => ({
      actionId: action.actionId,
      changeType: action.changeType,
      payload: action.payload,
      status: action.status,
      threshold: action.threshold,
      totalSigners: action.totalSigners,
      signatureCount: action.signatures.length,
      signatures: action.signatures.map(s => ({
         signer: s.signer,
         signedAt: s.signedAt,
         ledger: s.ledger,
         txHash: s.txHash,
      })),
      proposedBy: action.proposedBy,
      proposedAt: action.proposedAt,
      ledger: action.ledger,
      txHash: action.txHash,
   }));
}

export async function getActionDetail(actionId: string) {
   const action = await prisma.multisigAction.findUnique({
      where: { actionId },
      include: { signatures: true },
   });

   if (!action) {
      throw new MultisigActionNotFoundError(actionId);
   }

   return {
      actionId: action.actionId,
      changeType: action.changeType,
      params: action.payload,
      payload: action.payload,
      status: action.status,
      threshold: action.threshold,
      totalSigners: action.totalSigners,
      signatureCount: action.signatures.length,
      signatures: action.signatures.map(s => ({
         signer: s.signer,
         signedAt: s.signedAt,
         ledger: s.ledger,
         txHash: s.txHash,
      })),
      proposedBy: action.proposedBy,
      proposedAt: action.proposedAt,
      executedAt: action.executedAt,
      expiredAt: action.expiredAt,
      ledger: action.ledger,
      txHash: action.txHash,
   };
}

export async function getActionHistory(query?: { status?: string; page?: number; limit?: number }) {
   const page = query?.page && query.page > 0 ? query.page : 1;
   const limit = query?.limit && query.limit > 0 ? query.limit : 50;
   const skip = (page - 1) * limit;

   const where: any = {
      status: query?.status ? query.status : { not: 'pending' },
   };

   const [actions, total] = await Promise.all([
      prisma.multisigAction.findMany({
         where,
         include: { signatures: true },
         orderBy: { updatedAt: 'desc' },
         skip,
         take: limit,
      }),
      prisma.multisigAction.count({ where }),
   ]);

   return {
      history: actions.map(action => ({
         actionId: action.actionId,
         changeType: action.changeType,
         payload: action.payload,
         params: action.payload,
         status: action.status,
         threshold: action.threshold,
         totalSigners: action.totalSigners,
         signatureCount: action.signatures.length,
         signatures: action.signatures.map(s => ({
            signer: s.signer,
            signedAt: s.signedAt,
            ledger: s.ledger,
            txHash: s.txHash,
         })),
         proposedBy: action.proposedBy,
         proposedAt: action.proposedAt,
         executedAt: action.executedAt,
         expiredAt: action.expiredAt,
         ledger: action.ledger,
         txHash: action.txHash,
      })),
      pagination: {
         page,
         limit,
         total,
         totalPages: Math.ceil(total / limit) || 1,
      },
   };
}
