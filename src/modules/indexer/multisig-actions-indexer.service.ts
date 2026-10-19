import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { isEligibleSigner } from '../multisig/multisig-actions.service';

export const MULTISIG_ACTION_EVENT_TYPES = [
   'ActionProposed',
   'ACTION_PROPOSED',
   'ActionSigned',
   'ACTION_SIGNED',
   'ActionExecuted',
   'ACTION_EXECUTED',
] as const;

export function isMultisigActionEventType(eventType: string): boolean {
   return (MULTISIG_ACTION_EVENT_TYPES as readonly string[]).includes(eventType);
}

export interface ActionProposedEvent extends IndexerChainEvent {
   actionId: string;
   description?: string;
   target?: string;
   functionName?: string;
   function_name?: string;
   params?: Record<string, unknown>;
   threshold?: number;
   totalSigners?: number;
   total_signers?: number;
   proposedBy?: string;
   proposed_by?: string;
   proposedAt?: string | number | Date;
   txHash: string;
}

export interface ActionSignedEvent extends IndexerChainEvent {
   actionId: string;
   signer: string;
   signedAt?: string | number | Date;
   txHash: string;
}

export interface ActionExecutedEvent extends IndexerChainEvent {
   actionId: string;
   executedAt?: string | number | Date;
   outcome?: string;
   txHash: string;
}

/**
 * Indexes governance multisig action events (#1085).
 */
export async function processMultisigActionEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   const actionEvents = events.filter(e => isMultisigActionEventType(e.eventType));
   if (actionEvents.length === 0) return;

   await processIndexerChainEvents(actionEvents, async rawEvent => {
      const eventType = rawEvent.eventType;

      if (eventType === 'ActionProposed' || eventType === 'ACTION_PROPOSED') {
         const event = rawEvent as unknown as ActionProposedEvent;
         const actionId = event.actionId;
         if (!actionId) {
            logger.warn({ rawEvent }, 'ActionProposed missing actionId');
            return;
         }

         const proposedBy = event.proposedBy || event.proposed_by || (event as any).actor || 'unknown';
         const proposedAt = event.proposedAt ? new Date(event.proposedAt) : new Date();
         const threshold = Number(event.threshold || 2);
         const totalSigners = Number(event.totalSigners || event.total_signers || 3);
         const functionName = event.functionName || event.function_name || null;

         await (prisma as any).multisigAction.upsert({
            where: { actionId },
            update: {
               description: event.description ?? null,
               target: event.target ?? null,
               functionName,
               params: event.params ?? null,
               threshold,
               totalSigners,
               proposedBy,
               proposedAt,
               txHash: event.txHash ?? null,
            },
            create: {
               actionId,
               description: event.description ?? null,
               target: event.target ?? null,
               functionName,
               params: event.params ?? null,
               threshold,
               totalSigners,
               proposedBy,
               proposedAt,
               txHash: event.txHash ?? null,
               status: 'pending',
            },
         });
         return;
      }

      if (eventType === 'ActionSigned' || eventType === 'ACTION_SIGNED') {
         const event = rawEvent as unknown as ActionSignedEvent;
         const { actionId, signer, txHash } = event;
         if (!actionId || !signer) {
            logger.warn({ rawEvent }, 'ActionSigned missing actionId or signer');
            return;
         }

         if (!isEligibleSigner(signer)) {
            logger.warn({ actionId, signer }, 'Signer not in eligible set for multisig action');
            return;
         }

         const signedAt = event.signedAt ? new Date(event.signedAt) : new Date();

         await (prisma as any).multisigActionSignature.upsert({
            where: {
               actionId_signer: {
                  actionId,
                  signer,
               },
            },
            update: {
               signedAt,
               txHash: txHash ?? null,
            },
            create: {
               actionId,
               signer,
               signedAt,
               txHash: txHash ?? null,
            },
         });
         return;
      }

      if (eventType === 'ActionExecuted' || eventType === 'ACTION_EXECUTED') {
         const event = rawEvent as unknown as ActionExecutedEvent;
         const { actionId, outcome, txHash } = event;
         if (!actionId) {
            logger.warn({ rawEvent }, 'ActionExecuted missing actionId');
            return;
         }

         const executedAt = event.executedAt ? new Date(event.executedAt) : new Date();

         await (prisma as any).multisigAction.updateMany({
            where: { actionId },
            data: {
               status: 'executed',
               outcome: outcome ?? 'success',
               executedAt,
               txHash: txHash ?? undefined,
            },
         });
         return;
      }
   });
}
