// src/modules/badges/badge-mint.service.ts
// Core badge minting with deduplication, audit logging, and retry (#1148).
//
// `mintBadge` is the single entry point for awarding a badge:
//
//   1. Deduplication guard — a wallet already holding a badge type is never
//      re-minted (the badge_mint_log unique (wallet, badgeType) constraint
//      backs this even under concurrency).
//   2. Mint via the injected contract client, retrying transient failures up
//      to BADGE_MINT_MAX_ATTEMPTS. User-kind failures are terminal.
//   3. Every attempt's outcome is persisted to badge_mint_log for audit.
//
// Prisma, the contract client, the clock, and the delay are all injectable so
// the whole flow is unit-testable without a database or Soroban RPC.

import type { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import type { ContractErrorKind } from '../contracts/contract.types';
import { defaultBadgeMintContractClient } from './badge-mint.client';
import { mintMaxAttempts } from './badge.constants';
import type {
   BadgeMintContractClient,
   BadgeMintResult,
   BadgeTriggerEvent,
   BadgeType,
} from './badge.types';

export interface BadgeMintDeps {
   prisma?: typeof defaultPrisma;
   contractClient?: BadgeMintContractClient;
   now?: () => Date;
   /** Max mint attempts before a transient failure is treated as terminal. */
   maxAttempts?: number;
   /** Delay between retries; injectable so tests run instantly. */
   delay?: (ms: number) => Promise<void>;
   /** Base backoff delay in ms (linear per attempt). */
   baseDelayMs?: number;
}

const defaultDelay = (ms: number): Promise<void> =>
   new Promise(resolve => setTimeout(resolve, ms));

/** Classify a thrown mint error. Unknown errors are treated as transient. */
function classifyMintError(error: unknown): ContractErrorKind {
   const kind = (error as { kind?: unknown })?.kind;
   return kind === 'user' ? 'user' : 'transient';
}

function errorMessage(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
}

/**
 * Award a single badge to a wallet, deduplicating against prior mints and
 * retrying transient on-chain failures.
 */
export async function mintBadge(
   wallet: string,
   badgeType: BadgeType,
   triggerEvent: BadgeTriggerEvent,
   deps?: BadgeMintDeps,
   metadata?: Record<string, unknown>
): Promise<BadgeMintResult> {
   const prisma = deps?.prisma ?? defaultPrisma;
   const contractClient =
      deps?.contractClient ?? defaultBadgeMintContractClient;
   const getNow = deps?.now ?? (() => new Date());
   const maxAttempts = Math.max(1, deps?.maxAttempts ?? mintMaxAttempts());
   const delay = deps?.delay ?? defaultDelay;
   const baseDelayMs = deps?.baseDelayMs ?? 1000;

   // ── 1. Deduplication guard ───────────────────────────────────────────
   const existing = await prisma.badgeMintLog.findUnique({
      where: { wallet_badgeType: { wallet, badgeType } },
      select: { status: true, txHash: true, attempts: true },
   });

   if (existing?.status === 'MINTED') {
      logger.info(
         { wallet, badgeType },
         'Badge already minted for wallet; skipping (dedup)'
      );
      return {
         wallet,
         badgeType,
         status: 'SKIPPED',
         reason: 'already_earned',
         txHash: existing.txHash ?? undefined,
         attempts: existing.attempts,
      };
   }

   const callMint =
      contractClient.mint_badge?.bind(contractClient) ??
      contractClient.mintBadge.bind(contractClient);

   // ── 2. Mint with retry on transient failures ─────────────────────────
   let attempts = 0;
   let lastError = '';

   while (attempts < maxAttempts) {
      attempts += 1;
      try {
         const result = await callMint(wallet, badgeType);
         const txHash = result?.txHash ?? null;
         const mintedAt = getNow();

         await persistOutcome(prisma, {
            wallet,
            badgeType,
            triggerEvent,
            status: 'MINTED',
            txHash,
            attempts,
            error: null,
            mintedAt,
            metadata,
         });

         logger.info(
            { wallet, badgeType, triggerEvent, txHash, attempts },
            'Badge minted successfully'
         );

         return {
            wallet,
            badgeType,
            status: 'MINTED',
            txHash: txHash ?? undefined,
            attempts,
         };
      } catch (error) {
         lastError = errorMessage(error);
         const kind = classifyMintError(error);

         logger.warn(
            {
               wallet,
               badgeType,
               triggerEvent,
               attempt: attempts,
               max_attempts: maxAttempts,
               error_kind: kind,
               error: lastError,
            },
            'Badge mint attempt failed'
         );

         // User-kind failures cannot be fixed by retrying.
         if (kind === 'user') break;

         // Back off before another transient retry (not after the last one).
         if (attempts < maxAttempts) {
            await delay(baseDelayMs * attempts);
         }
      }
   }

   await persistOutcome(prisma, {
      wallet,
      badgeType,
      triggerEvent,
      status: 'FAILED',
      txHash: null,
      attempts,
      error: lastError,
      mintedAt: null,
      metadata,
   });

   return {
      wallet,
      badgeType,
      status: 'FAILED',
      attempts,
      error: lastError,
   };
}

/**
 * Upsert the badge_mint_log row for an attempt outcome. The unique
 * (wallet, badgeType) constraint keeps the audit trail to one row per award.
 */
async function persistOutcome(
   prisma: typeof defaultPrisma,
   row: {
      wallet: string;
      badgeType: BadgeType;
      triggerEvent: BadgeTriggerEvent;
      status: 'MINTED' | 'FAILED';
      txHash: string | null;
      attempts: number;
      error: string | null;
      mintedAt: Date | null;
      metadata?: Record<string, unknown>;
   }
): Promise<void> {
   try {
      const metadata =
         row.metadata === undefined
            ? undefined
            : (row.metadata as Prisma.InputJsonValue);
      await prisma.badgeMintLog.upsert({
         where: {
            wallet_badgeType: {
               wallet: row.wallet,
               badgeType: row.badgeType,
            },
         },
         create: {
            wallet: row.wallet,
            badgeType: row.badgeType,
            triggerEvent: row.triggerEvent,
            status: row.status,
            txHash: row.txHash,
            attempts: row.attempts,
            error: row.error,
            mintedAt: row.mintedAt,
            ...(metadata === undefined ? {} : { metadata }),
         },
         update: {
            status: row.status,
            triggerEvent: row.triggerEvent,
            txHash: row.txHash,
            attempts: row.attempts,
            error: row.error,
            mintedAt: row.mintedAt,
            ...(metadata === undefined ? {} : { metadata }),
         },
      });
   } catch (error) {
      // Logging must never break the award path (mirrors the contract service).
      logger.error(
         {
            wallet: row.wallet,
            badgeType: row.badgeType,
            error: errorMessage(error),
         },
         'Failed to persist badge mint log entry'
      );
   }
}
