import { prisma } from '../../utils/prisma.utils';
import { getIssuerScore } from './invoice-protocol.contract';

export class InvoiceProtocolNotFoundError extends Error {}
export interface ProtocolPage {
   page: number;
   limit: number;
}
export function pagination({ page, limit }: ProtocolPage, totalCount: number) {
   return {
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      hasNextPage: page * limit < totalCount,
      hasPrevPage: page > 1,
   };
}
export const pageArgs = ({ page, limit }: ProtocolPage) => ({
   skip: (page - 1) * limit,
   take: limit,
});

export async function requireInvoice(invoiceId: string) {
   const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
   });
   if (!invoice) throw new InvoiceProtocolNotFoundError('Invoice');
   return invoice;
}

export async function issuerReputation(wallet: string) {
   const score = await prisma.issuerScore.findUnique({ where: { wallet } });
   if (!score) throw new InvoiceProtocolNotFoundError('Issuer reputation');
   const [onChain, count] = await Promise.all([
      getIssuerScore(wallet, score.lastEventId),
      prisma.invoiceProtocolEvent.count({
         where: {
            entityKey: `issuer:${wallet}`,
            eventType: 'IssuerScoreUpdated',
         },
      }),
   ]);
   return { ...onChain, history_count: count, last_updated: score.lastUpdated };
}

export async function issuerHistory(wallet: string, page: ProtocolPage) {
   if (!(await prisma.issuerScore.findUnique({ where: { wallet } })))
      throw new InvoiceProtocolNotFoundError('Issuer reputation');
   const where = {
      entityKey: `issuer:${wallet}`,
      eventType: 'IssuerScoreUpdated',
   };
   const [rows, count] = await prisma.$transaction([
      prisma.invoiceProtocolEvent.findMany({
         where,
         ...pageArgs(page),
         orderBy: [
            { ledger: 'desc' },
            { transactionIndex: 'desc' },
            { eventIndex: 'desc' },
            { id: 'desc' },
         ],
      }),
      prisma.invoiceProtocolEvent.count({ where }),
   ]);
   return {
      data: rows.map(row => ({
         ...(row.payload as object),
         event_type: row.eventType,
         timestamp: row.timestamp,
         tx_hash: row.txHash,
         event_index: row.eventIndex,
      })),
      meta: pagination(page, count),
   };
}

export async function invoiceDetail(invoiceId: string) {
   const invoice = await requireInvoice(invoiceId);
   const active = await prisma.fraudReport.count({
      where: { invoiceId, status: 'OPEN' },
   });
   return {
      invoice_id: invoice.id,
      seller_wallet: invoice.sellerWallet,
      amount: invoice.amount.toString(),
      currency: invoice.currency,
      status: invoice.status,
      rate: invoice.rate?.toString() ?? null,
      maturity: invoice.maturityDate,
      risk_rating: invoice.riskRating,
      funding_progress: invoice.fundingProgress?.toString() ?? '0',
      under_review: active > 0,
   };
}

function reportView(
   report: Awaited<ReturnType<typeof prisma.fraudReport.findFirstOrThrow>>
) {
   return {
      report_id: report.reportId,
      invoice_id: report.invoiceId,
      reporter: report.reporter,
      evidence_hash: report.evidenceHash,
      notes: report.notes,
      status: report.status,
      resolution: report.resolution,
      resolution_notes: report.resolutionNotes,
      submitted_at: report.submittedAt,
      resolved_at: report.resolvedAt,
   };
}

export async function invoiceReports(invoiceId: string, page: ProtocolPage) {
   await requireInvoice(invoiceId);
   const where = { invoiceId };
   const [rows, count] = await prisma.$transaction([
      prisma.fraudReport.findMany({
         where,
         ...pageArgs(page),
         orderBy: [{ submittedAt: 'desc' }, { reportId: 'desc' }],
      }),
      prisma.fraudReport.count({ where }),
   ]);
   return { data: rows.map(reportView), meta: pagination(page, count) };
}

export async function invoiceReport(invoiceId: string, reportId: string) {
   const report = await prisma.fraudReport.findFirst({
      where: { invoiceId, reportId },
   });
   if (!report) throw new InvoiceProtocolNotFoundError('Report');
   return reportView(report);
}

function timelockView(
   row: Awaited<ReturnType<typeof prisma.timelockChange.findFirstOrThrow>>,
   now: number
) {
   return {
      proposal_id: row.proposalId,
      target: row.target,
      function: row.function,
      params: row.params,
      eta: row.eta,
      countdown_seconds:
         row.status === 'PENDING'
            ? Math.max(0, Math.ceil((row.eta.getTime() - now) / 1000))
            : 0,
      status: row.status,
      outcome: row.outcome,
      proposed_at: row.proposedAt,
      completed_at: row.completedAt,
   };
}

export async function timelockList(pending: boolean, page: ProtocolPage) {
   const where = {
      status: { in: pending ? ['PENDING'] : ['EXECUTED', 'CANCELLED'] },
   };
   const [rows, count] = await prisma.$transaction([
      prisma.timelockChange.findMany({
         where,
         ...pageArgs(page),
         orderBy: [{ proposedAt: 'desc' }, { proposalId: 'desc' }],
      }),
      prisma.timelockChange.count({ where }),
   ]);
   const now = Date.now();
   return {
      data: rows.map(row => timelockView(row, now)),
      meta: pagination(page, count),
   };
}

export async function timelockDetail(proposalId: string) {
   const row = await prisma.timelockChange.findUnique({
      where: { proposalId },
   });
   if (!row) throw new InvoiceProtocolNotFoundError('Timelock proposal');
   return timelockView(row, Date.now());
}

export async function transferAudit(invoiceId: string, page: ProtocolPage) {
   await requireInvoice(invoiceId);
   const where = { invoiceId };
   const [rows, count] = await prisma.$transaction([
      prisma.transferRestrictionEvent.findMany({
         where,
         ...pageArgs(page),
         orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      }),
      prisma.transferRestrictionEvent.count({ where }),
   ]);
   return {
      data: rows.map(row => ({
         invoice_id: row.invoiceId,
         from: row.fromWallet,
         to: row.toWallet,
         reason: row.reason,
         restriction_type: row.restrictionType,
         event_type: 'TransferBlocked',
         timestamp: row.timestamp,
         ledger: row.ledger,
         tx_hash: row.txHash,
         event_index: row.eventIndex,
      })),
      meta: pagination(page, count),
   };
}
