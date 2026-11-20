import { createHash } from 'crypto';
import { scValToNative, xdr } from '@stellar/stellar-base';
import { z } from 'zod';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

export const INVOICE_PROTOCOL_EVENT_TYPES = new Set([
   'IssuerScoreUpdated',
   'ReportSubmitted',
   'ReportResolved',
   'ChangeProposed',
   'ChangeExecuted',
   'ChangeCancelled',
   'TransferBlocked',
]);
const text = z.string().min(1).max(4096);
const id = z
   .union([z.string(), z.bigint(), z.number().int().nonnegative().safe()])
   .transform(String)
   .pipe(z.string().regex(/^(0|[1-9]\d*)$/))
   .refine(value => BigInt(value) <= 18446744073709551615n, 'ID exceeds u64');
const schemas: Record<string, z.ZodTypeAny> = {
   IssuerScoreUpdated: z.object({
      wallet: text,
      score: z
         .union([z.number(), z.string().regex(/^\d+$/)])
         .pipe(z.coerce.number().int().min(0).max(2147483647)),
      tier: text,
   }),
   ReportSubmitted: z.object({
      report_id: id,
      invoice_id: id,
      reporter: text,
      evidence_hash: text,
      notes: z.string().nullable().optional(),
   }),
   ReportResolved: z.object({
      report_id: id,
      invoice_id: id,
      resolution: text,
      resolution_notes: z.string().nullable().optional(),
   }),
   ChangeProposed: z.object({
      proposal_id: id,
      target: text,
      function: text,
      params: z.unknown().refine(value => value !== undefined),
      eta: z.union([z.string(), z.number().safe(), z.bigint()]),
   }),
   ChangeExecuted: z.object({
      proposal_id: id,
      outcome: z.string().optional(),
   }),
   ChangeCancelled: z.object({
      proposal_id: id,
      outcome: z.string().optional(),
   }),
   TransferBlocked: z.object({
      invoice_id: id,
      from: text,
      to: text,
      reason: text,
      restriction_type: text,
   }),
};

export function canonicalInvoiceEventType(type: string): string {
   return (
      [...INVOICE_PROTOCOL_EVENT_TYPES].find(
         name => name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase() === type
      ) ?? type
   );
}

export function chainTimestamp(value: unknown): Date {
   const numeric =
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      (typeof value === 'string' && /^\d+$/.test(value));
   const timestamp = numeric
      ? new Date(Number(value) * 1000)
      : new Date(String(value));
   if (!Number.isFinite(timestamp.getTime()))
      throw new Error('Invalid chain timestamp');
   return timestamp;
}

function jsonSafe(value: unknown): any {
   if (typeof value === 'bigint') return value.toString();
   if (Buffer.isBuffer(value)) return value.toString('hex');
   if (Array.isArray(value)) return value.map(jsonSafe);
   if (value && typeof value === 'object')
      return Object.fromEntries(
         Object.entries(value).map(([key, item]) => [key, jsonSafe(item)])
      );
   return value;
}

export function parseInvoiceProtocolEvent(event: IndexerChainEvent) {
   const eventType = canonicalInvoiceEventType(event.eventType);
   if (!INVOICE_PROTOCOL_EVENT_TYPES.has(eventType))
      throw new Error('Unknown invoice event type');
   const metadata = z
      .object({
         contractId: text,
         txHash: text,
         ledger: z.number().int().nonnegative().safe(),
         transactionIndex: z.number().int().nonnegative().safe(),
         eventIndex: z.number().int().nonnegative().safe(),
      })
      .parse(event);
   const payload = schemas[eventType].parse(jsonSafe(event.payload ?? event));
   if (eventType === 'ChangeProposed')
      payload.eta = chainTimestamp(payload.eta).toISOString();
   const entityKey =
      eventType === 'IssuerScoreUpdated'
         ? `issuer:${payload.wallet}`
         : eventType.startsWith('Report')
           ? `report:${payload.invoice_id}:${payload.report_id}`
           : eventType.startsWith('Change')
             ? `timelock:${payload.proposal_id}`
             : `transfer:${payload.invoice_id}:${payload.from}:${payload.to}`;
   return {
      ...metadata,
      eventType,
      payload,
      entityKey,
      timestamp: chainTimestamp(event.timestamp ?? event.ledgerClosedAt),
      id: createHash('sha256')
         .update(
            JSON.stringify([
               metadata.contractId,
               metadata.txHash,
               metadata.eventIndex,
            ])
         )
         .digest('hex'),
   };
}

/** Soroban RPC wire shape. The worker supplies the complete page in RPC order. */
export interface InvoiceProtocolRpcEvent {
   id: string;
   contractId: string;
   txHash: string;
   ledger: number;
   ledgerClosedAt: string;
   topic: string[];
   value: string;
   inSuccessfulContractCall?: boolean;
}

export function decodeInvoiceProtocolRpcEvent(
   raw: InvoiceProtocolRpcEvent
): IndexerChainEvent | null {
   if (raw.inSuccessfulContractCall === false) return null;
   const topics = raw.topic.map(item =>
      scValToNative(xdr.ScVal.fromXDR(item, 'base64'))
   );
   const eventType = canonicalInvoiceEventType(String(topics[0]));
   if (!INVOICE_PROTOCOL_EVENT_TYPES.has(eventType)) return null;
   // RPC IDs contain the ledger/transaction/operation TOID and event index.
   const match = /^(\d+)-(\d+)$/.exec(raw.id);
   if (!match) throw new Error('Invalid Soroban event cursor');
   const toid = BigInt(match[1]);
   if (Number(toid >> 32n) !== raw.ledger)
      throw new Error('Event cursor ledger mismatch');
   const event: IndexerChainEvent = {
      eventType,
      contractId: raw.contractId,
      txHash: raw.txHash,
      ledger: raw.ledger,
      transactionIndex: Number((toid >> 12n) & 0xfffffn),
      eventIndex: Number(match[2]),
      timestamp: raw.ledgerClosedAt,
      payload: scValToNative(xdr.ScVal.fromXDR(raw.value, 'base64')),
   };
   parseInvoiceProtocolEvent(event); // Reject malformed known events before checkpointing.
   return event;
}
