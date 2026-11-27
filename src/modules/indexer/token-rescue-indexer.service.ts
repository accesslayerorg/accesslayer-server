// src/modules/indexer/token-rescue-indexer.service.ts
// Indexes `rescued` contract events into TokenRescue (#1271).
//
// - Each (txHash, eventIndex) is stored once. A duplicate delivery is skipped
//   on the unique-constraint error, so it neither duplicates the row nor
//   fires a second alert.
// - A rescue whose amount is above TOKEN_RESCUE_ALERT_THRESHOLD sends one
//   alert to ALERT_WEBHOOK_URL (or PROTOCOL_ALERT_WEBHOOK_URL). Delivery
//   failures are logged and never fail the batch, so the cursor still moves.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';

export const TOKEN_RESCUE_EVENT_TYPES = new Set([
   'rescued',
   'Rescued',
   'RESCUED',
   'TokenRescued',
   'TOKEN_RESCUED',
]);

export function isTokenRescueEvent(event: IndexerChainEvent): boolean {
   return TOKEN_RESCUE_EVENT_TYPES.has(event.eventType);
}

export interface LargeTokenRescueAlert {
   event: 'token_rescue_above_threshold';
   token: string;
   recipient: string;
   admin: string;
   amount: string;
   threshold: string;
   ledger: number;
   txHash: string;
}

export type LargeTokenRescueAlertSender = (
   payload: LargeTokenRescueAlert
) => Promise<void>;

let customAlertSender: LargeTokenRescueAlertSender | null = null;

/** Test seam: replaces the webhook delivery. Pass null to restore it. */
export function setLargeTokenRescueAlertSender(
   sender: LargeTokenRescueAlertSender | null
): void {
   customAlertSender = sender;
}

function eventId(event: IndexerChainEvent): string {
   return `${event.txHash}:${event.eventIndex}`;
}

function stringValue(value: unknown): string | null {
   if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
   }
   if (typeof value === 'number' || typeof value === 'bigint') {
      return String(value);
   }
   return null;
}

function requiredString(
   event: IndexerChainEvent,
   name: string,
   ...candidates: unknown[]
): string {
   const value = candidates.map(stringValue).find(c => c !== null);
   if (value) return value;
   logger.error(
      { eventId: eventId(event), missingField: name },
      'Cannot index token rescue event with missing required data'
   );
   throw new Error(`Token rescue event is missing required ${name}`);
}

function isUniqueConstraintError(error: unknown): boolean {
   return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
   );
}

/** Parses the configured threshold. Unset or invalid means alerts are off. */
export function parseTokenRescueThreshold(raw: string | undefined): bigint | null {
   if (raw === undefined || raw.trim() === '') return null;
   try {
      const threshold = BigInt(raw.trim());
      return threshold >= 0n ? threshold : null;
   } catch {
      logger.warn(
         { threshold: raw },
         'TOKEN_RESCUE_ALERT_THRESHOLD is not an integer; large rescue alerts are disabled'
      );
      return null;
   }
}

async function deliverLargeRescueAlert(
   payload: LargeTokenRescueAlert
): Promise<void> {
   if (customAlertSender) {
      try {
         await customAlertSender(payload);
      } catch (error) {
         logger.warn(
            { error, txHash: payload.txHash },
            'Large token rescue alert sender failed'
         );
      }
      return;
   }

   const webhookUrl =
      process.env.ALERT_WEBHOOK_URL ?? process.env.PROTOCOL_ALERT_WEBHOOK_URL;
   if (!webhookUrl) return;

   try {
      const response = await fetch(webhookUrl, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify(payload),
         signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
         logger.warn(
            { status: response.status, txHash: payload.txHash },
            'Alert webhook returned non-2xx status for large token rescue'
         );
      }
   } catch (error) {
      logger.warn(
         { error, txHash: payload.txHash },
         'Failed to notify alert webhook for large token rescue'
      );
   }
}

async function applyTokenRescue(event: IndexerChainEvent): Promise<void> {
   const token = requiredString(event, 'token', event.token, event.tokenAddress, event.token_address);
   const recipient = requiredString(event, 'recipient', event.recipient, event.to);
   const admin = requiredString(event, 'admin', event.admin, event.actor);
   const rawAmount = stringValue(event.amount);
   if (rawAmount === null || !/^\d+$/.test(rawAmount)) {
      logger.error(
         { eventId: eventId(event), rawAmount },
         'Cannot index token rescue event with invalid amount'
      );
      throw new Error('Token rescue event has an invalid amount');
   }
   const amount = BigInt(rawAmount);
   const ledger = Number(event.ledger);
   if (!Number.isInteger(ledger)) {
      throw new Error('Token rescue event is missing a ledger');
   }

   try {
      await prisma.tokenRescue.create({
         data: {
            token,
            recipient,
            amount,
            admin,
            ledger,
            txHash: event.txHash,
            eventIndex: event.eventIndex,
         },
      });
   } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      logger.info(
         { eventId: eventId(event), token },
         'Token rescue already indexed; skipping duplicate event'
      );
      return;
   }

   const threshold = parseTokenRescueThreshold(envConfig.TOKEN_RESCUE_ALERT_THRESHOLD);
   if (threshold !== null && amount > threshold) {
      await deliverLargeRescueAlert({
         event: 'token_rescue_above_threshold',
         token,
         recipient,
         admin,
         amount: amount.toString(),
         threshold: threshold.toString(),
         ledger,
         txHash: event.txHash,
      });
   }
}

export async function processTokenRescueEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (isTokenRescueEvent(event)) {
         await applyTokenRescue(event);
      }
   });
}
