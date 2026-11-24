// src/modules/indexer/balance-checkpoint-indexer.service.ts
// Records per-(holder, keyId, ledger) balance checkpoints from indexer events (#1323).

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import type { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

export interface BalanceCheckpointInput {
   holder: string;
   keyId: string;
   ledger: number;
   balance: number;
   timestamp?: Date;
   db?: unknown;
}

interface BalanceCheckpointClient {
   balanceCheckpoint: {
      upsert: (args: {
         where: {
            holder_keyId_ledger: {
               holder: string;
               keyId: string;
               ledger: number;
            };
         };
         create: {
            holder: string;
            keyId: string;
            ledger: number;
            balance: number;
            timestamp: Date;
         };
         update: {
            balance: number;
            timestamp: Date;
         };
      }) => Promise<unknown>;
   };
}

export const BALANCE_CHANGE_EVENT_TYPES = new Set([
   'BALANCE_CHANGED',
   'BalanceChanged',
   'KEY_TRANSFERRED',
   'keys_transferred',
   'KEY_BURNED',
   'keys_burned',
   'KEY_MINTED',
   'KeyMinted',
]);

export function isBalanceChangeEvent(event: IndexerChainEvent): boolean {
   return BALANCE_CHANGE_EVENT_TYPES.has(event.eventType);
}

/**
 * Upserts a single BalanceCheckpoint for (holder, keyId, ledger).
 * Multiple balance changes within the same ledger overwrite the same row,
 * guaranteeing one checkpoint per holder, key, and ledger.
 */
export async function recordBalanceCheckpoint(
   input: BalanceCheckpointInput
): Promise<void> {
   const { holder, keyId, ledger, balance, timestamp, db } = input;
   if (
      !holder ||
      !keyId ||
      !Number.isInteger(ledger) ||
      ledger < 0 ||
      !Number.isFinite(balance)
   ) {
      return;
   }

   const ts = timestamp ?? new Date();
   const normalizedBalance = Math.max(0, balance);

   try {
      const client = (db ?? prisma) as unknown as BalanceCheckpointClient;
      await client.balanceCheckpoint.upsert({
         where: {
            holder_keyId_ledger: {
               holder,
               keyId,
               ledger,
            },
         },
         create: {
            holder,
            keyId,
            ledger,
            balance: normalizedBalance,
            timestamp: ts,
         },
         update: {
            balance: normalizedBalance,
            timestamp: ts,
         },
      });
   } catch (error) {
      logger.warn(
         {
            type: 'balance_checkpoint_write_failed',
            holder,
            keyId,
            ledger,
            error,
         },
         'balance-checkpoint: failed to upsert checkpoint'
      );
   }
}

function extractEntriesFromEvent(
   event: IndexerChainEvent
): BalanceCheckpointInput[] {
   const ledger = Number(event.ledger);
   if (!Number.isInteger(ledger) || ledger < 0) {
      return [];
   }
   const rawTimestamp =
      event.timestamp ?? event.tradeAt ?? event.occurredAt ?? event.createdAt;
   const timestamp = rawTimestamp ? new Date(rawTimestamp as string | Date) : new Date();
   const keyId = String(event.keyId ?? event.creatorId ?? '');
   if (!keyId) {
      return [];
   }

   const entries: BalanceCheckpointInput[] = [];

   // Transfer events may carry both fromBalance and toBalance
   if (
      event.fromAddress &&
      event.fromBalance !== undefined &&
      event.fromBalance !== null
   ) {
      entries.push({
         holder: String(event.fromAddress),
         keyId,
         ledger,
         balance: Number(event.fromBalance),
         timestamp,
      });
   }
   if (
      event.toAddress &&
      event.toBalance !== undefined &&
      event.toBalance !== null
   ) {
      entries.push({
         holder: String(event.toAddress),
         keyId,
         ledger,
         balance: Number(event.toBalance),
         timestamp,
      });
   }

   // Single-holder balance change event
   const holder = event.holder ?? event.actor ?? event.ownerAddress ?? event.burnerAddress;
   const rawBalance = event.balance ?? event.newBalance ?? event.postBalance;
   if (holder && rawBalance !== undefined && rawBalance !== null) {
      entries.push({
         holder: String(holder),
         keyId,
         ledger,
         balance: Number(rawBalance),
         timestamp,
      });
   }

   return entries;
}

/**
 * Processes a batch of balance change events, collapsing multiple changes
 * for the same (holder, keyId, ledger) in the batch to a single upsert.
 */
export async function processBalanceChangeEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   const latestByKey = new Map<string, BalanceCheckpointInput>();

   for (const event of events) {
      for (const entry of extractEntriesFromEvent(event)) {
         if (!Number.isFinite(entry.balance)) continue;
         const compositeKey = `${entry.holder}:${entry.keyId}:${entry.ledger}`;
         latestByKey.set(compositeKey, entry);
      }
   }

   for (const entry of latestByKey.values()) {
      await recordBalanceCheckpoint(entry);
   }
}
