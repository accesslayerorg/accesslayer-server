// src/modules/indexer/multisig-action-indexer.service.ts

import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { buildLogFields } from '../../utils/log-fields.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';

export interface ActionProposedEvent extends IndexerChainEvent {
   eventType: 'ACTION_PROPOSED' | 'ActionProposed' | 'action_proposed';
   actionId: string;
   changeType?: string;
   actionType?: string;
   payload?: Record<string, unknown>;
   params?: Record<string, unknown>;
   threshold?: number;
   totalSigners?: number;
   proposedBy: string;
   proposedAt?: string;
   occurredAt?: string;
}

export interface ActionSignedEvent extends IndexerChainEvent {
   eventType: 'ACTION_SIGNED' | 'ActionSigned' | 'action_signed';
   actionId: string;
   signer: string;
   signedAt?: string;
   occurredAt?: string;
}

export interface ActionExecutedEvent extends IndexerChainEvent {
   eventType: 'ACTION_EXECUTED' | 'ActionExecuted' | 'action_executed';
   actionId: string;
   status?: string;
   executedAt?: string;
   expiredAt?: string;
   occurredAt?: string;
}

export type MultisigChainEvent =
   | ActionProposedEvent
   | ActionSignedEvent
   | ActionExecutedEvent;

/**
 * Processes a batch of multi-sig action governance events (ActionProposed, ActionSigned, ActionExecuted).
 *
 * - Indexes events into `multisig_actions` and `signatures` tables.
 * - Deduplicates events and handles replay via unique constraints (P2002).
 */
export async function processMultisigActionEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      const rawType = event.eventType?.toUpperCase() || '';
      const normalizedType = rawType.replace(/_/g, '');

      if (
         normalizedType !== 'ACTIONPROPOSED' &&
         normalizedType !== 'ACTIONSIGNED' &&
         normalizedType !== 'ACTIONEXECUTED'
      ) {
         return;
      }

      try {
         if (normalizedType === 'ACTIONPROPOSED') {
            const e = event as ActionProposedEvent;
            if (!e.actionId || !e.proposedBy) {
               logger.warn(
                  buildLogFields({
                     type: 'multisig_action_event_invalid',
                     eventId: `${event.txHash}:${event.eventIndex}`,
                     eventType: event.eventType,
                  }),
                  'Skipping ActionProposed event due to missing required fields'
               );
               return;
            }

            const timestamp = e.proposedAt || e.occurredAt ? new Date(e.proposedAt || e.occurredAt!) : new Date();

            await prisma.multisigAction.upsert({
               where: { actionId: e.actionId },
               create: {
                  actionId: e.actionId,
                  changeType: e.changeType || e.actionType || 'general',
                  payload: (e.payload || e.params || {}) as Prisma.InputJsonValue,
                  status: 'pending',
                  threshold: Number(e.threshold ?? 2),
                  totalSigners: Number(e.totalSigners ?? 3),
                  proposedBy: e.proposedBy,
                  proposedAt: timestamp,
                  ledger: typeof event.ledger === 'number' ? event.ledger : null,
                  txHash: event.txHash ? String(event.txHash) : null,
               },
               update: {
                  // If already exists, don't overwrite pending status unless necessary
               },
            });
         } else if (normalizedType === 'ACTIONSIGNED') {
            const e = event as ActionSignedEvent;
            if (!e.actionId || !e.signer) {
               logger.warn(
                  buildLogFields({
                     type: 'multisig_signature_event_invalid',
                     eventId: `${event.txHash}:${event.eventIndex}`,
                     eventType: event.eventType,
                  }),
                  'Skipping ActionSigned event due to missing required fields'
               );
               return;
            }

            const timestamp = e.signedAt || e.occurredAt ? new Date(e.signedAt || e.occurredAt!) : new Date();

            await prisma.signature.create({
               data: {
                  actionId: e.actionId,
                  signer: e.signer,
                  signedAt: timestamp,
                  ledger: typeof event.ledger === 'number' ? event.ledger : null,
                  txHash: event.txHash ? String(event.txHash) : null,
               },
            }).catch(error => {
               if (
                  error instanceof Prisma.PrismaClientKnownRequestError &&
                  error.code === 'P2002'
               ) {
                  logger.debug(
                     { actionId: e.actionId, signer: e.signer },
                     'Signature already indexed; skipping duplicate'
                  );
                  return;
               }
               throw error;
            });
         } else if (normalizedType === 'ACTIONEXECUTED') {
            const e = event as ActionExecutedEvent;
            if (!e.actionId) {
               logger.warn(
                  buildLogFields({
                     type: 'multisig_executed_event_invalid',
                     eventId: `${event.txHash}:${event.eventIndex}`,
                     eventType: event.eventType,
                  }),
                  'Skipping ActionExecuted event due to missing actionId'
               );
               return;
            }

            const finalStatus = e.status ? e.status.toLowerCase() : 'executed';
            const timestamp = e.executedAt || e.expiredAt || e.occurredAt ? new Date(e.executedAt || e.expiredAt || e.occurredAt!) : new Date();

            await prisma.multisigAction.updateMany({
               where: { actionId: e.actionId },
               data: {
                  status: finalStatus,
                  executedAt: finalStatus === 'executed' ? timestamp : undefined,
                  expiredAt: finalStatus === 'expired' ? timestamp : undefined,
               },
            });
         }
      } catch (error) {
         if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
         ) {
            logger.debug(
               { eventId: `${event.txHash}:${event.eventIndex}` },
               'Multisig action event already applied; skipping replay'
            );
            return;
         }
         throw error;
      }
   });
}
