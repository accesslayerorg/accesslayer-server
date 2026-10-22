// src/modules/keys/key-export.service.ts
// Full analytics export for a single creator key (#1014).
//
// GET /keys/:keyId/export?format=csv|json&from=&to= collects every data type
// the creator dashboard shows — trades, holder snapshots, revenue events and
// milestone events — scoped to an inclusive [from, to] window and serialises
// them as CSV or JSON.
//
// Generation is asynchronous: the route inserts a PENDING job row, hands it
// to the in-process queue below and returns a signed download URL right away
// (well under the 5s budget). Large exports are therefore never bound by the
// request timeout — the worker keeps going and the download endpoint serves
// the payload once the job is READY.
//
// The download URL carries an HMAC-signed, expiring token (signed with
// APP_SECRET, the same primitive as cursor pagination) so the link is
// self-authorising for its short lifetime and needs no session.

import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { logger } from '../../utils/logger.utils';
import { KeyNotFoundError } from './key-fees.service';
import { extractXlmAmount } from '../creator/creator-analytics.service';

/** How long a signed download URL stays valid. */
export const KEY_EXPORT_URL_TTL_SECONDS = 3600;

/**
 * Per-section row cap. Exports are generated in the background so the request
 * never blocks, but the payload is buffered in memory before it is stored —
 * this bounds that buffer. Sections that hit the cap are flagged via
 * `truncated` in the JSON payload / CSV summary row.
 */
export const KEY_EXPORT_ROW_LIMIT = 50_000;

/** Activity types that represent creator revenue flowing to holders. */
export const KEY_EXPORT_REVENUE_ACTIVITY_TYPES = ['DIVIDEND_DISTRIBUTED'] as const;

export type ExportFormat = 'csv' | 'json';

export interface ExportWindow {
   from?: Date;
   to?: Date;
}

/** Query params accepted by GET /:keyId/export. */
export const keyExportQuerySchema = z
   .object({
      format: z.enum(['csv', 'json']).default('json'),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
   })
   .refine(q => !q.from || !q.to || new Date(q.from) <= new Date(q.to), {
      message: 'from must be before or equal to to',
      path: ['from'],
   })
   .transform(
      (q): { format: ExportFormat; from?: Date; to?: Date } => ({
         format: q.format,
         from: q.from ? new Date(q.from) : undefined,
         to: q.to ? new Date(q.to) : undefined,
      })
   );

// ── Signed download tokens ───────────────────────────────────

/** Raised for a missing, malformed, tampered or expired download token. */
export class ExportDownloadTokenError extends Error {
   constructor(message = 'Invalid or expired export download token') {
      super(message);
      this.name = 'ExportDownloadTokenError';
   }
}

export interface ExportTokenPayload {
   jobId: string;
   exp: number;
}

function hmac(payload: string): string {
   return crypto
      .createHmac('sha256', envConfig.APP_SECRET)
      .update(payload)
      .digest('base64url');
}

/** Sign a token granting time-limited access to one export job's download. */
export function signKeyExportToken(jobId: string, expiresAt: Date): string {
   const payload = Buffer.from(
      JSON.stringify({ jobId, exp: Math.floor(expiresAt.getTime() / 1000) })
   ).toString('base64url');
   return `${payload}.${hmac(payload)}`;
}

/** Verify a download token, throwing {@link ExportDownloadTokenError} on failure. */
export function verifyKeyExportToken(token: string): ExportTokenPayload {
   if (!token || typeof token !== 'string') {
      throw new ExportDownloadTokenError('Missing export download token');
   }

   const [payload, signature] = token.split('.');
   if (!payload || !signature) {
      throw new ExportDownloadTokenError('Malformed export download token');
   }

   const expected = Buffer.from(hmac(payload));
   const provided = Buffer.from(signature);
   if (
      expected.length !== provided.length ||
      !crypto.timingSafeEqual(expected, provided)
   ) {
      throw new ExportDownloadTokenError('Invalid export download token');
   }

   let decoded: unknown;
   try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
   } catch {
      throw new ExportDownloadTokenError('Malformed export download token');
   }

   const { jobId, exp } = (decoded ?? {}) as Partial<ExportTokenPayload>;
   if (typeof jobId !== 'string' || typeof exp !== 'number') {
      throw new ExportDownloadTokenError('Malformed export download token');
   }
   if (exp * 1000 < Date.now()) {
      throw new ExportDownloadTokenError('Export download link has expired');
   }

   return { jobId, exp };
}

export function buildKeyExportDownloadUrl(jobId: string, token: string): string {
   const base = envConfig.BACKEND_URL.replace(/\/+$/, '');
   return `${base}/api/v1/keys/exports/${jobId}/download?token=${encodeURIComponent(
      token
   )}`;
}

// ── Export payload model ─────────────────────────────────────

export interface KeyExportTrade {
   id: string;
   timestamp: string;
   buyer: string;
   quantity: string;
   price: string;
   paymentAsset: string;
   value: string;
   ledger: number;
   txHash: string;
}

export interface KeyExportHolderSnapshot {
   id: string;
   ownerAddress: string;
   balance: string;
   recordedAt: string;
}

export interface KeyExportRevenueEvent {
   id: string;
   eventType: string;
   actor: string;
   amount: string;
   createdAt: string;
}

export interface KeyExportMilestoneEvent {
   id: string;
   eventType: string;
   ledger: number | null;
   txHash: string | null;
   score: number;
   recordedAt: string;
}

export interface KeyExportRevenueBreakdown {
   tradeCount: number;
   totalTradeVolume: string;
   totalCreatorRoyalty: string;
   totalDividendsDistributed: string;
}

export interface KeyExportData {
   keyId: string;
   from: string | null;
   to: string | null;
   generatedAt: string;
   summary: {
      tradeCount: number;
      holderSnapshotCount: number;
      revenueEventCount: number;
      milestoneEventCount: number;
      truncated: boolean;
   };
   trades: KeyExportTrade[];
   holderSnapshots: KeyExportHolderSnapshot[];
   revenueEvents: KeyExportRevenueEvent[];
   revenueBreakdown: KeyExportRevenueBreakdown;
   milestoneEvents: KeyExportMilestoneEvent[];
}

export interface SerializedKeyExport {
   content: string;
   contentType: string;
   fileName: string;
   /** Trades + holder snapshots + revenue events + milestone events. */
   recordCount: number;
}

/** Row returned to the caller that enqueued the export job. */
export interface AcceptedKeyExportJob {
   jobId: string;
   keyId: string;
   status: string;
   format: ExportFormat;
   from: string | null;
   to: string | null;
   expiresAt: string;
   downloadUrl: string;
}

// ── Data collection ──────────────────────────────────────────

export interface ResolvedCreator {
   id: string;
   creatorRoyaltyBuyBps: number;
   creatorRoyaltySellBps: number;
}

export async function resolveExportCreator(
   keyId: string
): Promise<ResolvedCreator> {
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: {
         id: true,
         creatorRoyaltyBuyBps: true,
         creatorRoyaltySellBps: true,
      },
   });
   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }
   return creator;
}

function rangeFilter(
   from?: Date,
   to?: Date
): { gte?: Date; lte?: Date } | undefined {
   if (!from && !to) return undefined;
   return {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
   };
}

/** Apply the row cap, reporting whether the section was clipped. */
function capSection<T>(rows: T[]): { rows: T[]; truncated: boolean } {
   if (rows.length <= KEY_EXPORT_ROW_LIMIT) {
      return { rows, truncated: false };
   }
   return { rows: rows.slice(0, KEY_EXPORT_ROW_LIMIT), truncated: true };
}

/**
 * Collect and normalise all exportable analytics for a key within the
 * inclusive [from, to] window. The same window is applied to every data type:
 * Trade.timestamp, WalletHoldingSnapshot.recordedAt, Activity.createdAt and
 * CreatorReputationHistory.recordedAt.
 */
export async function buildKeyExport(
   keyId: string,
   window: ExportWindow = {}
): Promise<KeyExportData> {
   const creator = await resolveExportCreator(keyId);
   const range = rangeFilter(window.from, window.to);

   const [tradeRows, snapshotRows, revenueRows, milestoneRows] =
      await Promise.all([
         prisma.trade.findMany({
            where: {
               creatorId: creator.id,
               ...(range ? { timestamp: range } : {}),
            },
            orderBy: { timestamp: 'asc' },
            take: KEY_EXPORT_ROW_LIMIT + 1,
         }),
         prisma.walletHoldingSnapshot.findMany({
            where: {
               creatorId: creator.id,
               ...(range ? { recordedAt: range } : {}),
            },
            orderBy: { recordedAt: 'asc' },
            take: KEY_EXPORT_ROW_LIMIT + 1,
         }),
         prisma.activity.findMany({
            where: {
               creatorId: creator.id,
               type: { in: [...KEY_EXPORT_REVENUE_ACTIVITY_TYPES] },
               ...(range ? { createdAt: range } : {}),
            },
            orderBy: { createdAt: 'asc' },
            take: KEY_EXPORT_ROW_LIMIT + 1,
         }),
         prisma.creatorReputationHistory.findMany({
            where: {
               creatorId: creator.id,
               eventType: 'MILESTONE_REACHED',
               ...(range ? { recordedAt: range } : {}),
            },
            orderBy: { recordedAt: 'asc' },
            take: KEY_EXPORT_ROW_LIMIT + 1,
         }),
      ]);

   const trades = capSection(tradeRows as any[]);
   const snapshots = capSection(snapshotRows as any[]);
   const revenue = capSection(revenueRows as any[]);
   const milestones = capSection(milestoneRows as any[]);

   const royaltyBps = BigInt(
      Math.max(creator.creatorRoyaltyBuyBps, creator.creatorRoyaltySellBps)
   );
   let totalVolume = 0n;
   let totalRoyalty = 0n;

   const exportTrades: KeyExportTrade[] = trades.rows.map(trade => {
      const value = BigInt(trade.price) * BigInt(trade.quantity);
      totalVolume += value;
      totalRoyalty += (value * royaltyBps) / 10000n;
      return {
         id: trade.id,
         timestamp: trade.timestamp.toISOString(),
         buyer: trade.buyer,
         quantity: trade.quantity,
         price: trade.price,
         paymentAsset: trade.paymentAsset,
         value: value.toString(),
         ledger: trade.ledger,
         txHash: trade.txHash,
      };
   });

   const holderSnapshots: KeyExportHolderSnapshot[] = snapshots.rows.map(row => ({
      id: row.id,
      ownerAddress: row.ownerAddress,
      balance: row.balance.toString(),
      recordedAt: row.recordedAt.toISOString(),
   }));

   let totalDividends = 0;
   const revenueEvents: KeyExportRevenueEvent[] = revenue.rows.map(row => {
      const amount = extractXlmAmount(row.payload);
      totalDividends += amount;
      return {
         id: row.id,
         eventType: String(row.type),
         actor: row.actor,
         amount: amount.toString(),
         createdAt: row.createdAt.toISOString(),
      };
   });

   const milestoneEvents: KeyExportMilestoneEvent[] = milestones.rows.map(row => ({
      id: row.id,
      eventType: row.eventType,
      ledger: row.ledger ?? null,
      txHash: row.txHash ?? null,
      score: row.score,
      recordedAt: row.recordedAt.toISOString(),
   }));

   return {
      keyId: creator.id,
      from: window.from?.toISOString() ?? null,
      to: window.to?.toISOString() ?? null,
      generatedAt: new Date().toISOString(),
      summary: {
         tradeCount: exportTrades.length,
         holderSnapshotCount: holderSnapshots.length,
         revenueEventCount: revenueEvents.length,
         milestoneEventCount: milestoneEvents.length,
         truncated:
            trades.truncated ||
            snapshots.truncated ||
            revenue.truncated ||
            milestones.truncated,
      },
      trades: exportTrades,
      holderSnapshots,
      revenueEvents,
      revenueBreakdown: {
         tradeCount: exportTrades.length,
         totalTradeVolume: totalVolume.toString(),
         totalCreatorRoyalty: totalRoyalty.toString(),
         totalDividendsDistributed: totalDividends.toFixed(7),
      },
      milestoneEvents,
   };
}

// ── Serialisation ────────────────────────────────────────────

/**
 * Column order for the flat CSV export. Section rows share one sheet and are
 * distinguished by `record_type`; columns that do not apply to a row are left
 * blank so a single file carries every specified field.
 */
export const KEY_EXPORT_CSV_FIELDS = [
   'record_type',
   'trade_id',
   'trade_timestamp',
   'buyer',
   'quantity',
   'price',
   'payment_asset',
   'trade_value',
   'ledger',
   'tx_hash',
   'snapshot_id',
   'owner_address',
   'balance',
   'snapshot_recorded_at',
   'revenue_event_id',
   'revenue_event_type',
   'revenue_actor',
   'revenue_amount',
   'revenue_created_at',
   'total_trade_count',
   'total_trade_volume',
   'total_creator_royalty',
   'total_dividends_distributed',
   'milestone_event_id',
   'milestone_event_type',
   'milestone_ledger',
   'milestone_tx_hash',
   'milestone_score',
   'milestone_recorded_at',
] as const;

export type KeyExportCsvField = (typeof KEY_EXPORT_CSV_FIELDS)[number];

function csvEscape(value: unknown): string {
   if (value === null || value === undefined) return '';
   const str = String(value);
   if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
   }
   return str;
}

export function keyExportRows(
   data: KeyExportData
): Array<Partial<Record<KeyExportCsvField, string | number>>> {
   const rows: Array<Partial<Record<KeyExportCsvField, string | number>>> = [];

   for (const trade of data.trades) {
      rows.push({
         record_type: 'trade',
         trade_id: trade.id,
         trade_timestamp: trade.timestamp,
         buyer: trade.buyer,
         quantity: trade.quantity,
         price: trade.price,
         payment_asset: trade.paymentAsset,
         trade_value: trade.value,
         ledger: trade.ledger,
         tx_hash: trade.txHash,
      });
   }

   for (const snapshot of data.holderSnapshots) {
      rows.push({
         record_type: 'holder_snapshot',
         snapshot_id: snapshot.id,
         owner_address: snapshot.ownerAddress,
         balance: snapshot.balance,
         snapshot_recorded_at: snapshot.recordedAt,
      });
   }

   for (const event of data.revenueEvents) {
      rows.push({
         record_type: 'revenue_event',
         revenue_event_id: event.id,
         revenue_event_type: event.eventType,
         revenue_actor: event.actor,
         revenue_amount: event.amount,
         revenue_created_at: event.createdAt,
      });
   }

   rows.push({
      record_type: 'revenue_breakdown',
      total_trade_count: data.revenueBreakdown.tradeCount,
      total_trade_volume: data.revenueBreakdown.totalTradeVolume,
      total_creator_royalty: data.revenueBreakdown.totalCreatorRoyalty,
      total_dividends_distributed:
         data.revenueBreakdown.totalDividendsDistributed,
   });

   for (const event of data.milestoneEvents) {
      rows.push({
         record_type: 'milestone_event',
         milestone_event_id: event.id,
         milestone_event_type: event.eventType,
         milestone_ledger: event.ledger ?? '',
         milestone_tx_hash: event.txHash ?? '',
         milestone_score: event.score,
         milestone_recorded_at: event.recordedAt,
      });
   }

   return rows;
}

export function toCsv(
   rows: Array<Partial<Record<KeyExportCsvField, string | number>>>
): string {
   const header = KEY_EXPORT_CSV_FIELDS.join(',');
   const lines = rows.map(row =>
      KEY_EXPORT_CSV_FIELDS.map(field => csvEscape(row[field])).join(',')
   );
   return [header, ...lines].join('\n');
}

/** Build the download filename for a completed export. */
export function buildKeyExportFileName(
   keyId: string,
   format: ExportFormat,
   generatedAt: string
): string {
   const stamp = generatedAt.replace(/[:.]/g, '-');
   return `key-export-${keyId}-${stamp}.${format}`;
}

export function serializeKeyExport(
   format: ExportFormat,
   data: KeyExportData
): SerializedKeyExport {
   const fileName = buildKeyExportFileName(data.keyId, format, data.generatedAt);
   const recordCount =
      data.trades.length +
      data.holderSnapshots.length +
      data.revenueEvents.length +
      data.milestoneEvents.length;

   if (format === 'csv') {
      return {
         content: toCsv(keyExportRows(data)),
         contentType: 'text/csv; charset=utf-8',
         fileName,
         recordCount,
      };
   }

   return {
      content: JSON.stringify({ format: 'json', ...data }, null, 2),
      contentType: 'application/json; charset=utf-8',
      fileName,
      recordCount,
   };
}

// ── Async job queue ──────────────────────────────────────────

/**
 * Jobs run sequentially on a promise chain so order is preserved and the
 * chain can be awaited (`waitForKeyExportQueue`) in tests. Each step catches
 * its own errors, so one bad job never stalls the queue.
 */
let exportChain: Promise<void> = Promise.resolve();

export function enqueueKeyExport(jobId: string): void {
   exportChain = exportChain
      .then(() => processKeyExportJob(jobId))
      .catch(error => {
         logger.error({ error, jobId }, 'key-export: job processing failed');
      });
}

/** Resolve once every enqueued export job has finished. */
export function waitForKeyExportQueue(): Promise<void> {
   return exportChain;
}

export async function processKeyExportJob(jobId: string): Promise<void> {
   const job = await prisma.keyExportJob.findUnique({ where: { id: jobId } });
   if (!job) {
      logger.warn({ jobId }, 'key-export: job not found');
      return;
   }
   if (job.status !== 'PENDING') {
      return;
   }

   await prisma.keyExportJob.update({
      where: { id: jobId },
      data: { status: 'PROCESSING', startedAt: new Date() },
   });

   try {
      const data = await buildKeyExport(job.keyId, {
         from: job.from ?? undefined,
         to: job.to ?? undefined,
      });
      const format: ExportFormat = job.format === 'csv' ? 'csv' : 'json';
      const serialized = serializeKeyExport(format, data);

      await prisma.keyExportJob.update({
         where: { id: jobId },
         data: {
            status: 'READY',
            content: serialized.content,
            contentType: serialized.contentType,
            fileName: serialized.fileName,
            recordCount: serialized.recordCount,
            completedAt: new Date(),
         },
      });

      logger.info(
         { jobId, keyId: job.keyId, recordCount: serialized.recordCount },
         'key-export: job completed'
      );
   } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.keyExportJob
         .update({
            where: { id: jobId },
            data: { status: 'FAILED', error: message, completedAt: new Date() },
         })
         .catch(updateError => {
            logger.error(
               { error: updateError, jobId },
               'key-export: failed to mark job as FAILED'
            );
         });
      logger.error({ error, jobId }, 'key-export: job failed');
   }
}

/**
 * Create the PENDING job row, queue it for background generation, and return
 * the signed download URL. Only a single insert stands between the caller and
 * the URL, so this stays well within the 5s budget regardless of export size.
 */
export async function createKeyExportJob(params: {
   keyId: string;
   requestedBy: string;
   format: ExportFormat;
   from?: Date;
   to?: Date;
}): Promise<AcceptedKeyExportJob> {
   const creator = await resolveExportCreator(params.keyId);
   const expiresAt = new Date(Date.now() + KEY_EXPORT_URL_TTL_SECONDS * 1000);

   const job = await prisma.keyExportJob.create({
      data: {
         keyId: creator.id,
         requestedBy: params.requestedBy,
         format: params.format,
         from: params.from ?? null,
         to: params.to ?? null,
         status: 'PENDING',
         expiresAt,
      },
   });

   const token = signKeyExportToken(job.id, expiresAt);
   enqueueKeyExport(job.id);

   return {
      jobId: job.id,
      keyId: creator.id,
      status: job.status,
      format: params.format,
      from: params.from?.toISOString() ?? null,
      to: params.to?.toISOString() ?? null,
      expiresAt: expiresAt.toISOString(),
      downloadUrl: buildKeyExportDownloadUrl(job.id, token),
   };
}

// ── Signed download resolution ───────────────────────────────

export type KeyExportDownloadResolution =
   | { kind: 'ready'; fileName: string; contentType: string; content: string }
   | { kind: 'pending'; status: string }
   | { kind: 'failed'; error: string | null }
   | { kind: 'expired' }
   | { kind: 'not_found' };

/**
 * Validate the signed token and job id, then resolve what to serve. Throws
 * {@link ExportDownloadTokenError} when the token itself is invalid or
 * expired, so the route can answer 403 without leaking job existence.
 */
export async function resolveKeyExportDownload(
   jobId: string,
   token: string
): Promise<KeyExportDownloadResolution> {
   const payload = verifyKeyExportToken(token);
   if (payload.jobId !== jobId) {
      throw new ExportDownloadTokenError('Export download token does not match job');
   }

   const job = await prisma.keyExportJob.findUnique({ where: { id: jobId } });
   if (!job) return { kind: 'not_found' };
   if (job.expiresAt.getTime() < Date.now()) return { kind: 'expired' };

   if (job.status === 'READY' && job.content !== null) {
      return {
         kind: 'ready',
         fileName: job.fileName ?? `${jobId}.${job.format}`,
         contentType:
            job.contentType ??
            (job.format === 'csv'
               ? 'text/csv; charset=utf-8'
               : 'application/json; charset=utf-8'),
         content: job.content,
      };
   }

   if (job.status === 'FAILED') {
      return { kind: 'failed', error: job.error };
   }

   return { kind: 'pending', status: job.status };
}
