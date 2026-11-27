// src/modules/account/data-export.service.ts
// Personal data export for a user account (#1325). The archive contains only
// records owned by the requesting user: their account, linked wallet, creator
// profiles and posts, comments and orders made from their wallet, and their
// watchlist and alert/auto-invest settings. Other users' records are never
// queried.

import { Prisma } from '@prisma/client';
import { envConfig } from '../../config';
import { prisma } from '../../utils/prisma.utils';
import { signLink, verifyLink } from '../../utils/signed-url.utils';
import {
   DATA_EXPORT_LINK_TTL_MS,
   DATA_EXPORT_PURPOSE,
   DATA_EXPORT_STALE_PROCESSING_MS,
} from './account.constants';

export const DATA_EXPORT_SCHEMA_VERSION = 1;

export interface DataExportArchive {
   schemaVersion: number;
   generatedAt: string;
   account: {
      userId: string;
      email: string;
      firstName: string;
      lastName: string;
      phoneNumber: string | null;
      emailVerified: boolean;
      createdAt: string;
   };
   wallet: { address: string; linkedAt: string } | null;
   creatorProfiles: Array<{
      id: string;
      handle: string;
      displayName: string;
      bio: string | null;
      avatarUrl: string | null;
      twitter: string | null;
      website: string | null;
      discord: string | null;
      perkSummary: string | null;
      createdAt: string;
   }>;
   /** Posts published by the user's creator profiles. */
   creatorPosts: Array<{ id: string; creatorId: string; content: string; createdAt: string }>;
   comments: Array<{ id: string; keyId: string; body: string; createdAt: string }>;
   orders: Array<{
      id: string;
      keyId: string;
      side: string;
      targetPrice: string;
      quantity: string;
      status: string;
      expiresAt: string | null;
      createdAt: string;
   }>;
   preferences: {
      watchlist: Array<{ invoiceId: string; createdAt: string }>;
   };
   settings: {
      priceAlerts: Array<{
         creatorId: string;
         targetPrice: string;
         direction: string;
         isActive: boolean;
         createdAt: string;
      }>;
      autoInvestRules: Array<{
         category: string;
         minRating: string | null;
         maxPrice: string;
         maxPerKey: number;
         isActive: boolean;
         createdAt: string;
      }>;
   };
}

export type DataExportStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'expired';

export interface DataExportJobView {
   id: string;
   status: DataExportStatus;
   requestedAt: string;
   completedAt: string | null;
   expiresAt: string | null;
   downloadUrl: string | null;
}

export class DataExportInProgressError extends Error {
   constructor(public readonly jobId: string) {
      super('A data export is already in progress for this account');
      this.name = 'DataExportInProgressError';
   }
}

export class DataExportNotFoundError extends Error {
   constructor(message = 'Data export not found') {
      super(message);
      this.name = 'DataExportNotFoundError';
   }
}

export class InvalidDownloadLinkError extends Error {
   constructor() {
      super('Download link is invalid or has expired');
      this.name = 'InvalidDownloadLinkError';
   }
}

const iso = (value: Date): string => value.toISOString();
const isoOrNull = (value: Date | null): string | null => (value ? value.toISOString() : null);

/** Builds the archive for one user. Every query is scoped to that user. */
export async function buildDataExportArchive(
   userId: string,
   now: Date = new Date()
): Promise<DataExportArchive> {
   const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
         id: true,
         email: true,
         firstName: true,
         lastName: true,
         phoneNumber: true,
         emailVerified: true,
         createdAt: true,
         stellarWallet: { select: { address: true, createdAt: true } },
         creatorProfiles: {
            select: {
               id: true,
               handle: true,
               displayName: true,
               bio: true,
               avatarUrl: true,
               twitter: true,
               website: true,
               discord: true,
               perkSummary: true,
               createdAt: true,
            },
         },
      },
   });
   if (!user) {
      throw new DataExportNotFoundError('User not found');
   }

   const wallet = user.stellarWallet?.address ?? null;
   const creatorIds = user.creatorProfiles.map(profile => profile.id);

   // Each query is skipped (empty list) when the user has no such owner key.
   const scoped = <T>(query: () => Promise<T[]>, enabled: boolean): Promise<T[]> =>
      enabled ? query() : Promise.resolve([]);

   const [posts, comments, orders, priceAlerts, autoInvestRules, watchlist] =
      await Promise.all([
         scoped(
            () =>
               prisma.creatorPost.findMany({
                  where: { creatorId: { in: creatorIds } },
                  orderBy: { createdAt: 'asc' },
               }),
            creatorIds.length > 0
         ),
         scoped(
            () =>
               prisma.comment.findMany({
                  where: { author: wallet ?? '' },
                  orderBy: { createdAt: 'asc' },
               }),
            wallet !== null
         ),
         scoped(
            () =>
               prisma.limitOrder.findMany({
                  where: { wallet: wallet ?? '' },
                  orderBy: { createdAt: 'asc' },
               }),
            wallet !== null
         ),
         scoped(
            () =>
               prisma.priceAlert.findMany({
                  where: { walletAddress: wallet ?? '' },
                  orderBy: { createdAt: 'asc' },
               }),
            wallet !== null
         ),
         scoped(
            () =>
               prisma.autoInvestRule.findMany({
                  where: { walletAddress: wallet ?? '' },
                  orderBy: { createdAt: 'asc' },
               }),
            wallet !== null
         ),
         scoped(
            () =>
               prisma.investorWatchlist.findMany({
                  where: { walletAddress: wallet ?? '' },
                  orderBy: { createdAt: 'asc' },
               }),
            wallet !== null
         ),
      ]);

   return {
      schemaVersion: DATA_EXPORT_SCHEMA_VERSION,
      generatedAt: iso(now),
      account: {
         userId: user.id,
         email: user.email,
         firstName: user.firstName,
         lastName: user.lastName,
         phoneNumber: user.phoneNumber ?? null,
         emailVerified: user.emailVerified,
         createdAt: iso(user.createdAt),
      },
      wallet: user.stellarWallet
         ? { address: user.stellarWallet.address, linkedAt: iso(user.stellarWallet.createdAt) }
         : null,
      creatorProfiles: user.creatorProfiles.map(profile => ({
         id: profile.id,
         handle: profile.handle,
         displayName: profile.displayName,
         bio: profile.bio ?? null,
         avatarUrl: profile.avatarUrl ?? null,
         twitter: profile.twitter ?? null,
         website: profile.website ?? null,
         discord: profile.discord ?? null,
         perkSummary: profile.perkSummary ?? null,
         createdAt: iso(profile.createdAt),
      })),
      creatorPosts: posts.map(post => ({
         id: post.id,
         creatorId: post.creatorId,
         content: post.content,
         createdAt: iso(post.createdAt),
      })),
      comments: comments.map(comment => ({
         id: comment.id,
         keyId: comment.keyId,
         body: comment.body,
         createdAt: iso(comment.createdAt),
      })),
      orders: orders.map(order => ({
         id: order.id,
         keyId: order.keyId,
         side: order.side,
         targetPrice: order.targetPrice.toString(),
         quantity: order.quantity.toString(),
         status: order.status,
         expiresAt: isoOrNull(order.expiresAt),
         createdAt: iso(order.createdAt),
      })),
      preferences: {
         watchlist: watchlist.map(entry => ({
            invoiceId: entry.invoiceId,
            createdAt: iso(entry.createdAt),
         })),
      },
      settings: {
         priceAlerts: priceAlerts.map(alert => ({
            creatorId: alert.creatorId,
            targetPrice: alert.targetPrice.toString(),
            direction: alert.direction,
            isActive: alert.isActive,
            createdAt: iso(alert.createdAt),
         })),
         autoInvestRules: autoInvestRules.map(rule => ({
            category: rule.category,
            minRating: rule.minRating ? rule.minRating.toString() : null,
            maxPrice: rule.maxPrice.toString(),
            maxPerKey: rule.maxPerKey,
            isActive: rule.isActive,
            createdAt: iso(rule.createdAt),
         })),
      },
   };
}

function downloadUrlFor(jobId: string, expiresAt: Date): string {
   const expiresMs = expiresAt.getTime();
   const signature = signLink(DATA_EXPORT_PURPOSE, jobId, expiresMs);
   const base = envConfig.BACKEND_URL.replace(/\/+$/, '');
   return `${base}/v1/me/data-export/${jobId}/download?expires=${expiresMs}&sig=${signature}`;
}

interface DataExportJobRow {
   id: string;
   status: string;
   requestedAt: Date;
   completedAt: Date | null;
   expiresAt: Date | null;
}

/** Public view of a job. An elapsed download window reads as `expired`. */
export function toDataExportJobView(job: DataExportJobRow, now: Date = new Date()): DataExportJobView {
   const expired =
      job.status === 'completed' && job.expiresAt !== null && job.expiresAt.getTime() <= now.getTime();
   const available = job.status === 'completed' && !expired && job.expiresAt !== null;
   return {
      id: job.id,
      status: expired ? 'expired' : (job.status as DataExportStatus),
      requestedAt: iso(job.requestedAt),
      completedAt: isoOrNull(job.completedAt),
      expiresAt: isoOrNull(job.expiresAt),
      downloadUrl: available && job.expiresAt ? downloadUrlFor(job.id, job.expiresAt) : null,
   };
}

/** Queues an export. Only one export may be queued or running at a time. */
export async function requestDataExport(userId: string, now: Date = new Date()): Promise<DataExportJobView> {
   const active = await prisma.dataExportJob.findFirst({
      where: { userId, status: { in: ['queued', 'processing'] } },
      select: { id: true },
   });
   if (active) {
      throw new DataExportInProgressError(active.id);
   }
   const job = await prisma.dataExportJob.create({ data: { userId } });
   return toDataExportJobView(job, now);
}

/** Returns one of the user's own export jobs. Other users' jobs look missing. */
export async function getDataExportJob(
   userId: string,
   jobId: string,
   now: Date = new Date()
): Promise<DataExportJobView> {
   const job = await prisma.dataExportJob.findUnique({ where: { id: jobId } });
   if (!job || job.userId !== userId) {
      throw new DataExportNotFoundError();
   }
   return toDataExportJobView(job, now);
}

/**
 * Serves an archive for a valid, unexpired signed link. The link is bound to
 * the job id and to its exact expiry, so it cannot be replayed for another job.
 */
export async function readDataExportDownload(
   jobId: string,
   expiresMs: number,
   signature: string,
   now: Date = new Date()
): Promise<DataExportArchive> {
   if (!verifyLink(DATA_EXPORT_PURPOSE, jobId, expiresMs, signature, now.getTime())) {
      throw new InvalidDownloadLinkError();
   }
   const job = await prisma.dataExportJob.findUnique({ where: { id: jobId } });
   if (
      !job ||
      job.status !== 'completed' ||
      !job.archive ||
      !job.expiresAt ||
      job.expiresAt.getTime() !== expiresMs
   ) {
      throw new InvalidDownloadLinkError();
   }
   return job.archive as unknown as DataExportArchive;
}

function errorMessage(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
}

/**
 * Builds archives for queued jobs, and re-queues jobs left `processing` by a
 * crashed run. Each job is claimed with a conditional update so two workers
 * never build the same archive.
 */
export async function processDataExportJobs(
   now: Date = new Date(),
   limit = 5
): Promise<{ completed: number; failed: number }> {
   const staleBefore = new Date(now.getTime() - DATA_EXPORT_STALE_PROCESSING_MS);
   const jobs = await prisma.dataExportJob.findMany({
      where: {
         OR: [
            { status: 'queued' },
            { status: 'processing', updatedAt: { lt: staleBefore } },
         ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, userId: true, status: true },
   });

   let completed = 0;
   let failed = 0;
   for (const job of jobs) {
      const claimed = await prisma.dataExportJob.updateMany({
         where: { id: job.id, status: job.status },
         data: { status: 'processing' },
      });
      if (claimed.count === 0) continue;

      try {
         const archive = await buildDataExportArchive(job.userId, now);
         await prisma.dataExportJob.update({
            where: { id: job.id },
            data: {
               status: 'completed',
               archive: JSON.parse(JSON.stringify(archive)) as Prisma.InputJsonValue,
               error: null,
               completedAt: now,
               expiresAt: new Date(now.getTime() + DATA_EXPORT_LINK_TTL_MS),
            },
         });
         completed++;
      } catch (error) {
         await prisma.dataExportJob.update({
            where: { id: job.id },
            data: { status: 'failed', error: errorMessage(error) },
         });
         failed++;
      }
   }
   return { completed, failed };
}

/** Discards archives whose download window has closed. */
export async function expireDataExportArchives(now: Date = new Date()): Promise<number> {
   const result = await prisma.dataExportJob.updateMany({
      where: { status: 'completed', expiresAt: { lte: now } },
      data: { status: 'expired', archive: Prisma.DbNull },
   });
   return result.count;
}
