import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import {
   issuerCacheKey,
   invalidateTransferCheck,
} from '../invoice/invoice-protocol.contract';
import { parseInvoiceProtocolEvent } from './invoice-protocol.events';

const chainOrder = [
   { ledger: 'desc' },
   { transactionIndex: 'desc' },
   { eventIndex: 'desc' },
] as const;

/** Durable idempotency and an entity lock protect both replay and concurrent workers. */
export async function processInvoiceProtocolEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async raw => {
      const event = parseInvoiceProtocolEvent(raw);
      const expectedContract =
         event.eventType === 'IssuerScoreUpdated'
            ? envConfig.ISSUER_REPUTATION_CONTRACT_ID
            : event.eventType.startsWith('Report')
              ? envConfig.INVOICE_FRAUD_CONTRACT_ID
              : event.eventType.startsWith('Change')
                ? envConfig.INVOICE_TIMELOCK_CONTRACT_ID
                : envConfig.INVOICE_TRANSFER_CONTRACT_ID;
      if (!expectedContract || event.contractId !== expectedContract) {
         throw new Error(`Unexpected contract for ${event.eventType}`);
      }
      const previousScoreKey = await prisma.$transaction(async tx => {
         // hash collisions only serialize unrelated entities; they cannot
         // compromise identity, which is checked by the unique constraints.
         await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${event.entityKey}))`;
         await tx.invoiceProtocolEvent.createMany({
            data: [event],
            skipDuplicates: true,
         });
         const latest = (eventType: string) =>
            tx.invoiceProtocolEvent.findFirst({
               where: {
                  entityKey: event.entityKey,
                  eventType,
                  contractId: event.contractId,
               },
               orderBy: [...chainOrder],
            });
         if (event.eventType === 'IssuerScoreUpdated') {
            const row = (await latest('IssuerScoreUpdated'))!;
            const payload = row.payload as {
               wallet: string;
               score: number;
               tier: string;
            };
            const old = await tx.issuerScore.findUnique({
               where: { wallet: payload.wallet },
            });
            const data = {
               score: payload.score,
               tier: payload.tier,
               lastUpdated: row.timestamp,
               lastEventId: row.id,
            };
            await tx.issuerScore.upsert({
               where: { wallet: payload.wallet },
               create: { wallet: payload.wallet, ...data },
               update: data,
            });
            return old ? issuerCacheKey(payload.wallet, old.lastEventId) : null;
         }
         if (event.eventType.startsWith('Report')) {
            const submitted = await latest('ReportSubmitted');
            // Keep an early resolution in the journal until its submission
            // arrives, so backfills converge regardless of delivery order.
            if (!submitted) return null;
            const resolved = await latest('ReportResolved');
            const report = submitted.payload as Record<string, string>;
            const resolution = resolved?.payload as
               | Record<string, string>
               | undefined;
            const data = {
               invoiceId: report.invoice_id,
               reporter: report.reporter,
               evidenceHash: report.evidence_hash,
               notes: report.notes ?? null,
               status: resolved ? 'RESOLVED' : 'OPEN',
               resolution: resolution?.resolution ?? null,
               resolutionNotes: resolution?.resolution_notes ?? null,
               submittedAt: submitted.timestamp,
               resolvedAt: resolved?.timestamp ?? null,
            };
            await tx.fraudReport.upsert({
               where: {
                  invoiceId_reportId: {
                     invoiceId: report.invoice_id,
                     reportId: report.report_id,
                  },
               },
               create: { reportId: report.report_id, ...data },
               update: data,
            });
         } else if (event.eventType.startsWith('Change')) {
            const proposed = await latest('ChangeProposed');
            if (!proposed) return null;
            const terminal = await tx.invoiceProtocolEvent.findFirst({
               where: {
                  entityKey: event.entityKey,
                  contractId: event.contractId,
                  eventType: { in: ['ChangeExecuted', 'ChangeCancelled'] },
               },
               orderBy: [...chainOrder],
            });
            const proposal = proposed.payload as {
               proposal_id: string;
               target: string;
               function: string;
               params: Prisma.InputJsonValue;
               eta: string;
            };
            const status =
               terminal?.eventType === 'ChangeExecuted'
                  ? 'EXECUTED'
                  : terminal
                    ? 'CANCELLED'
                    : 'PENDING';
            const data = {
               target: proposal.target,
               function: proposal.function,
               params:
                  proposal.params === null ? Prisma.JsonNull : proposal.params,
               eta: new Date(proposal.eta),
               status,
               outcome:
                  (terminal?.payload as Record<string, string> | undefined)
                     ?.outcome ?? (terminal ? status : null),
               proposedAt: proposed.timestamp,
               completedAt: terminal?.timestamp ?? null,
            };
            await tx.timelockChange.upsert({
               where: { proposalId: proposal.proposal_id },
               create: { proposalId: proposal.proposal_id, ...data },
               update: data,
            });
         } else if (event.eventType === 'TransferBlocked') {
            const payload = event.payload;
            await tx.transferRestrictionEvent.createMany({
               data: [
                  {
                     id: event.id,
                     invoiceId: payload.invoice_id,
                     fromWallet: payload.from,
                     toWallet: payload.to,
                     reason: payload.reason,
                     restrictionType: payload.restriction_type,
                     timestamp: event.timestamp,
                     ledger: event.ledger,
                     txHash: event.txHash,
                     eventIndex: event.eventIndex,
                  },
               ],
               skipDuplicates: true,
            });
         }
         return null;
      });
      // Invalidation runs on replay too: a crash after commit cannot lose it.
      if (previousScoreKey) await cacheInvalidate(previousScoreKey);
      if (event.eventType === 'TransferBlocked') {
         await invalidateTransferCheck(
            event.payload.from,
            event.payload.to,
            event.payload.invoice_id
         );
      }
   });
}
