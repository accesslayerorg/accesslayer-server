// src/modules/protocol/fee-change.service.ts
// Protocol fee change indexer, pending timelock state, historical FeeService.at(ledger),
// and alert webhook notifications (#1308).

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';

export const PROTOCOL_FEE_CHANGE_EVENT_TYPES = new Set([
   'fee_change_queued',
   'fee_change_executed',
   'fee_change_cancelled',
]);

const STELLAR_SECONDS_PER_LEDGER = 5;

export type FeeAlertWebhookSender = (payload: {
   event: 'fee_change_queued';
   changeId: string | null;
   protocolFeeBps: number;
   creatorFeeBps: number | null;
   queuedLedger: number;
   executeAfterLedger: number;
   estimatedExecuteAt: string;
   txHash: string;
}) => Promise<void>;

let customWebhookSender: FeeAlertWebhookSender | null = null;

export function setFeeAlertWebhookSender(
   sender: FeeAlertWebhookSender | null
): void {
   customWebhookSender = sender;
}

async function notifyAlertWebhook(payload: Parameters<FeeAlertWebhookSender>[0]): Promise<void> {
   if (customWebhookSender) {
      await customWebhookSender(payload);
      return;
   }

   const webhookUrl =
      process.env.ALERT_WEBHOOK_URL ??
      process.env.PROTOCOL_ALERT_WEBHOOK_URL;
   if (!webhookUrl) {
      return;
   }

   try {
      const response = await fetch(webhookUrl, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify(payload),
         signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
         logger.warn(
            { status: response.status, changeId: payload.changeId },
            'Alert webhook returned non-2xx status for queued fee change'
         );
      }
   } catch (error) {
      logger.warn(
         { error, changeId: payload.changeId },
         'Failed to notify alert webhook for queued fee change'
      );
   }
}

export function estimateExecutionTime(
   queuedLedger: number,
   executeAfterLedger: number,
   queuedAt: Date = new Date()
): Date {
   const ledgerDelta = Math.max(0, executeAfterLedger - queuedLedger);
   return new Date(
      queuedAt.getTime() + ledgerDelta * STELLAR_SECONDS_PER_LEDGER * 1000
   );
}

function eventDate(value: unknown, fallback = new Date()): Date {
   if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
      const n = Number(value);
      const d = new Date(n < 1e12 ? n * 1000 : n);
      if (!Number.isNaN(d.getTime())) return d;
   }
   const d = value ? new Date(String(value)) : fallback;
   return Number.isNaN(d.getTime()) ? fallback : d;
}

/**
 * Idempotently processes `fee_change_queued`, `fee_change_executed`, and
 * `fee_change_cancelled` chain events.
 */
export async function processProtocolFeeChangeEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!PROTOCOL_FEE_CHANGE_EVENT_TYPES.has(event.eventType)) {
         return;
      }

      if (!event.txHash || !Number.isInteger(event.eventIndex)) {
         throw new Error('Fee change event requires txHash and eventIndex');
      }

      const ledger = Number(event.ledger ?? 0);
      const occurredAt = eventDate(event.timestamp);

      if (event.eventType === 'fee_change_queued') {
         const protocolFeeBps = Number(event.protocolFeeBps ?? event.feeBps);
         if (!Number.isFinite(protocolFeeBps) || protocolFeeBps < 0) {
            throw new Error('fee_change_queued requires valid protocolFeeBps');
         }

         const creatorFeeBps =
            event.creatorFeeBps !== undefined && event.creatorFeeBps !== null
               ? Number(event.creatorFeeBps)
               : null;
         const executeAfterLedger = Number(
            event.executeAfterLedger ?? event.executionLedger ?? ledger
         );
         const changeId = event.changeId ? String(event.changeId) : null;

         const existing = await prisma.pendingFeeChange.findUnique({
            where: {
               queuedTxHash_queuedEventIndex: {
                  queuedTxHash: event.txHash,
                  queuedEventIndex: event.eventIndex,
               },
            },
            select: { id: true },
         });

         if (existing) {
            return;
         }

         const estimatedExecuteAt = event.estimatedExecuteAt
            ? eventDate(event.estimatedExecuteAt, occurredAt)
            : estimateExecutionTime(ledger, executeAfterLedger, occurredAt);

         await prisma.pendingFeeChange.create({
            data: {
               changeId,
               protocolFeeBps,
               creatorFeeBps,
               feeTiers: (event.feeTiers as any) ?? undefined,
               queuedLedger: ledger,
               executeAfterLedger,
               estimatedExecuteAt,
               status: 'PENDING',
               queuedTxHash: event.txHash,
               queuedEventIndex: event.eventIndex,
            },
         });

         await notifyAlertWebhook({
            event: 'fee_change_queued',
            changeId,
            protocolFeeBps,
            creatorFeeBps,
            queuedLedger: ledger,
            executeAfterLedger,
            estimatedExecuteAt: estimatedExecuteAt.toISOString(),
            txHash: event.txHash,
         });
         return;
      }

      const changeId = event.changeId ? String(event.changeId) : null;
      const pending = changeId
         ? await prisma.pendingFeeChange.findUnique({ where: { changeId } })
         : await prisma.pendingFeeChange.findFirst({
              where: { status: 'PENDING' },
              orderBy: { queuedLedger: 'desc' },
           });

      if (event.eventType === 'fee_change_executed') {
         const protocolFeeBps = Number(
            event.protocolFeeBps ?? event.feeBps ?? pending?.protocolFeeBps
         );
         if (!Number.isFinite(protocolFeeBps) || protocolFeeBps < 0) {
            throw new Error('fee_change_executed requires valid protocolFeeBps');
         }

         const creatorFeeBps =
            event.creatorFeeBps !== undefined && event.creatorFeeBps !== null
               ? Number(event.creatorFeeBps)
               : pending?.creatorFeeBps ?? null;
         const feeTiers = event.feeTiers ?? pending?.feeTiers ?? undefined;

         if (pending) {
            const duplicate =
               pending.resolvedTxHash === event.txHash &&
               pending.resolvedEventIndex === event.eventIndex;
            if (!duplicate) {
               await prisma.pendingFeeChange.update({
                  where: { id: pending.id },
                  data: {
                     status: 'EXECUTED',
                     resolvedTxHash: event.txHash,
                     resolvedEventIndex: event.eventIndex,
                     resolvedLedger: ledger,
                     resolvedAt: occurredAt,
                  },
               });
            }
         }

         await prisma.feeConfigHistory.upsert({
            where: {
               txHash_eventIndex: {
                  txHash: event.txHash,
                  eventIndex: event.eventIndex,
               },
            },
            create: {
               protocolFeeBps,
               creatorFeeBps,
               feeTiers: feeTiers as any,
               effectiveLedger: ledger,
               txHash: event.txHash,
               eventIndex: event.eventIndex,
               effectiveAt: occurredAt,
            },
            update: {},
         });

         await prisma.protocolConfig.upsert({
            where: { id: 'default' },
            create: {
               id: 'default',
               protocolFeeBps,
               ...(feeTiers !== undefined ? { feeTiers: feeTiers as any } : {}),
            },
            update: {
               protocolFeeBps,
               ...(feeTiers !== undefined ? { feeTiers: feeTiers as any } : {}),
            },
         });
         return;
      }

      if (event.eventType === 'fee_change_cancelled' && pending) {
         const duplicate =
            pending.resolvedTxHash === event.txHash &&
            pending.resolvedEventIndex === event.eventIndex;
         if (!duplicate) {
            await prisma.pendingFeeChange.update({
               where: { id: pending.id },
               data: {
                  status: 'CANCELLED',
                  resolvedTxHash: event.txHash,
                  resolvedEventIndex: event.eventIndex,
                  resolvedLedger: ledger,
                  resolvedAt: occurredAt,
               },
            });
         }
      }
   });
}

/**
 * Returns the current protocol fee configuration and any pending timelocked change.
 */
export async function getProtocolFeesState() {
   const [config, latestHistory, pending] = await Promise.all([
      prisma.protocolConfig.findUnique({ where: { id: 'default' } }),
      prisma.feeConfigHistory.findFirst({
         orderBy: [{ effectiveLedger: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.pendingFeeChange.findFirst({
         where: { status: 'PENDING' },
         orderBy: { queuedLedger: 'desc' },
      }),
   ]);

   const current = {
      protocolFeeBps:
         latestHistory?.protocolFeeBps ?? config?.protocolFeeBps ?? 500,
      creatorFeeBps: latestHistory?.creatorFeeBps ?? null,
      feeTiers: latestHistory?.feeTiers ?? config?.feeTiers ?? null,
      effectiveLedger: latestHistory?.effectiveLedger ?? 0,
      effectiveAt: latestHistory?.effectiveAt?.toISOString() ?? null,
   };

   return {
      current,
      pending: pending
         ? {
              id: pending.id,
              changeId: pending.changeId,
              protocolFeeBps: pending.protocolFeeBps,
              creatorFeeBps: pending.creatorFeeBps,
              feeTiers: pending.feeTiers,
              queuedLedger: pending.queuedLedger,
              executeAfterLedger: pending.executeAfterLedger,
              estimatedExecuteAt: (
                 pending.estimatedExecuteAt ??
                 estimateExecutionTime(
                    pending.queuedLedger,
                    pending.executeAfterLedger,
                    pending.createdAt
                 )
              ).toISOString(),
              status: pending.status,
           }
         : null,
   };
}

/**
 * Returns cursor-paginated past protocol fee configurations with effective ledgers.
 */
export async function getProtocolFeesHistory(input: {
   cursor?: string;
   limit?: number;
}) {
   const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
   const rows = await prisma.feeConfigHistory.findMany({
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      orderBy: [{ effectiveLedger: 'desc' }, { createdAt: 'desc' }],
      take: limit + 1,
   });

   const hasMore = rows.length > limit;
   const items = hasMore ? rows.slice(0, limit) : rows;
   const nextCursor = hasMore ? items[items.length - 1].id : null;

   return {
      items,
      nextCursor,
   };
}

/**
 * FeeService provides historical protocol fee lookup for any ledger.
 */
export class FeeService {
   /**
    * Returns the fee configuration in force at the given Stellar ledger.
    */
   static async at(ledger: number) {
      const entry = await prisma.feeConfigHistory.findFirst({
         where: { effectiveLedger: { lte: ledger } },
         orderBy: [{ effectiveLedger: 'desc' }, { createdAt: 'desc' }],
      });

      if (entry) {
         return {
            protocolFeeBps: entry.protocolFeeBps,
            creatorFeeBps: entry.creatorFeeBps,
            feeTiers: entry.feeTiers,
            effectiveLedger: entry.effectiveLedger,
            effectiveAt: entry.effectiveAt.toISOString(),
         };
      }

      const fallback = await prisma.protocolConfig.findUnique({
         where: { id: 'default' },
      });

      return {
         protocolFeeBps: fallback?.protocolFeeBps ?? 500,
         creatorFeeBps: null,
         feeTiers: fallback?.feeTiers ?? null,
         effectiveLedger: 0,
         effectiveAt: null,
      };
   }
}
