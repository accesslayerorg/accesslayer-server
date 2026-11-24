// src/modules/changelog/changelog.service.ts
// Product changelog: public What's new feed, per-wallet unread tracking and
// admin draft / schedule / publish workflow (#1356).
//
// Visibility is computed at read time: an entry is public when it is
// PUBLISHED, or SCHEDULED with `publishedAt` in the past. Scheduled entries
// therefore go live exactly on time without a worker flipping their status.

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheInvalidate, cacheSetJson } from '../../utils/redis.utils';
import { CursorChecksumError, decodeCursor, encodeCursor } from '../../utils/cursor.utils';
import { sanitizeChangelogMarkdown, sanitizeChangelogTitle } from './changelog.sanitize';

export const CHANGELOG_CATEGORIES = ['NEW', 'IMPROVED', 'FIXED'] as const;
export type ChangelogCategory = (typeof CHANGELOG_CATEGORIES)[number];
export type ChangelogStatus = 'DRAFT' | 'SCHEDULED' | 'PUBLISHED';

export const CHANGELOG_CACHE_PREFIX = 'changelog:list:v1:';
export const CHANGELOG_CACHE_TTL_SECONDS = 300;
export const CHANGELOG_DEFAULT_LIMIT = 20;
export const CHANGELOG_MAX_LIMIT = 50;

const VISIBLE_STATUSES: ChangelogStatus[] = ['PUBLISHED', 'SCHEDULED'];

export class ChangelogServiceError extends Error {
   statusCode: number;
   code: string;

   constructor(statusCode: number, code: string, message: string) {
      super(message);
      this.name = 'ChangelogServiceError';
      this.statusCode = statusCode;
      this.code = code;
   }
}

interface ChangelogEntryRow {
   id: string;
   title: string;
   body: string;
   category: ChangelogCategory;
   status: ChangelogStatus;
   version: string | null;
   url: string | null;
   publishedAt: Date | null;
   createdBy: string;
   createdAt: Date;
   updatedAt: Date;
}

export interface PublicChangelogEntry {
   id: string;
   title: string;
   body: string;
   category: ChangelogCategory;
   version: string | null;
   url: string | null;
   publishedAt: string;
}

export interface ChangelogPage {
   entries: PublicChangelogEntry[];
   nextCursor: string | null;
}

interface FeedCursor {
   publishedAt: string;
   id: string;
}

function toPublicEntry(row: ChangelogEntryRow): PublicChangelogEntry {
   return {
      id: row.id,
      title: row.title,
      body: row.body,
      category: row.category,
      version: row.version,
      url: row.url,
      publishedAt: (row.publishedAt as Date).toISOString(),
   };
}

/** Prisma filter for entries the public can see at `now`. */
export function visibleEntryWhere(now: Date, category?: ChangelogCategory) {
   return {
      status: { in: VISIBLE_STATUSES },
      publishedAt: { lte: now },
      ...(category ? { category } : {}),
   };
}

function clampLimit(limit?: number): number {
   if (limit === undefined || !Number.isFinite(limit)) return CHANGELOG_DEFAULT_LIMIT;
   return Math.min(CHANGELOG_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function parseCursor(cursor: string): FeedCursor {
   try {
      const decoded = decodeCursor<FeedCursor>(cursor);
      if (
         typeof decoded?.id !== 'string' ||
         typeof decoded?.publishedAt !== 'string' ||
         Number.isNaN(Date.parse(decoded.publishedAt))
      ) {
         throw new CursorChecksumError('Malformed changelog cursor');
      }
      return decoded;
   } catch {
      throw new ChangelogServiceError(400, 'VALIDATION_ERROR', 'Invalid cursor');
   }
}

/**
 * Seconds the public list may be cached at `now`: the standard 5 minutes,
 * shortened so the cache expires when the next scheduled entry goes live.
 * Returns 0 when that moment is under a second away (do not cache).
 */
export function changelogCacheTtlSeconds(now: Date, nextScheduledAt: Date | null): number {
   if (!nextScheduledAt) return CHANGELOG_CACHE_TTL_SECONDS;
   const untilLive = Math.floor((nextScheduledAt.getTime() - now.getTime()) / 1000);
   return Math.max(0, Math.min(CHANGELOG_CACHE_TTL_SECONDS, untilLive));
}

async function nextScheduledAt(now: Date): Promise<Date | null> {
   const next = await prisma.changelogEntry.findFirst({
      where: { status: 'SCHEDULED', publishedAt: { gt: now } },
      orderBy: { publishedAt: 'asc' },
      select: { publishedAt: true },
   });
   return next?.publishedAt ?? null;
}

async function queryVisiblePage(params: {
   now: Date;
   category?: ChangelogCategory;
   cursor?: FeedCursor;
   limit: number;
}): Promise<ChangelogPage> {
   const { now, category, cursor, limit } = params;
   const after = cursor
      ? {
           OR: [
              { publishedAt: { lt: new Date(cursor.publishedAt) } },
              { publishedAt: new Date(cursor.publishedAt), id: { lt: cursor.id } },
           ],
        }
      : {};
   const rows = (await prisma.changelogEntry.findMany({
      where: { AND: [visibleEntryWhere(now, category), after] },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
   })) as ChangelogEntryRow[];

   const page = rows.slice(0, limit);
   const last = page[page.length - 1];
   return {
      entries: page.map(toPublicEntry),
      nextCursor:
         rows.length > limit && last
            ? encodeCursor<FeedCursor>({
                 publishedAt: (last.publishedAt as Date).toISOString(),
                 id: last.id,
              })
            : null,
   };
}

/**
 * Public What's new feed, newest first. Cached per (category, cursor, limit)
 * for up to 5 minutes; the TTL never outlives the next scheduled go-live.
 */
export async function listPublishedEntries(params: {
   category?: ChangelogCategory;
   cursor?: string;
   limit?: number;
   now?: Date;
}): Promise<ChangelogPage> {
   const now = params.now ?? new Date();
   const limit = clampLimit(params.limit);
   const cursor = params.cursor ? parseCursor(params.cursor) : undefined;
   const cacheKey = `${CHANGELOG_CACHE_PREFIX}${params.category ?? 'all'}:${limit}:${params.cursor ?? 'first'}`;

   const cached = await cacheGetJson<ChangelogPage>(cacheKey);
   if (cached) return cached;

   const page = await queryVisiblePage({ now, category: params.category, cursor, limit });
   const ttl = changelogCacheTtlSeconds(now, await nextScheduledAt(now));
   if (ttl > 0) await cacheSetJson(cacheKey, page, ttl);
   return page;
}

/** Drops every cached page of the public list. */
export async function invalidateChangelogCache(): Promise<void> {
   await cacheInvalidate(`${CHANGELOG_CACHE_PREFIX}*`);
}

/** Visible entries published after the wallet last opened the feed. */
export async function getUnreadCount(walletAddress: string, now: Date = new Date()): Promise<number> {
   const read = await prisma.changelogRead.findUnique({
      where: { walletAddress },
      select: { lastReadAt: true },
   });
   const where = visibleEntryWhere(now);
   return prisma.changelogEntry.count({
      where: read ? { ...where, publishedAt: { gt: read.lastReadAt, lte: now } } : where,
   });
}

/** Marks everything visible at `now` as read for the wallet. */
export async function markAllRead(
   walletAddress: string,
   now: Date = new Date()
): Promise<{ lastReadAt: string; unreadCount: number }> {
   await prisma.changelogRead.upsert({
      where: { walletAddress },
      create: { walletAddress, lastReadAt: now },
      update: { lastReadAt: now },
   });
   return { lastReadAt: now.toISOString(), unreadCount: 0 };
}

// ── Admin workflow ──────────────────────────────────────────────

export interface ChangelogContentInput {
   title?: string;
   body?: string;
   category?: ChangelogCategory;
   version?: string | null;
   url?: string | null;
}

function sanitizeContent(input: ChangelogContentInput): ChangelogContentInput {
   const out: ChangelogContentInput = { ...input };
   if (input.title !== undefined) {
      out.title = sanitizeChangelogTitle(input.title);
      if (!out.title) {
         throw new ChangelogServiceError(400, 'VALIDATION_ERROR', 'Title is empty after sanitization');
      }
   }
   if (input.body !== undefined) {
      out.body = sanitizeChangelogMarkdown(input.body);
      if (!out.body) {
         throw new ChangelogServiceError(400, 'VALIDATION_ERROR', 'Body is empty after sanitization');
      }
   }
   if (input.version !== undefined && input.version !== null) {
      out.version = sanitizeChangelogTitle(input.version) || null;
   }
   return out;
}

async function getEntryOrThrow(id: string): Promise<ChangelogEntryRow> {
   const entry = (await prisma.changelogEntry.findUnique({ where: { id } })) as ChangelogEntryRow | null;
   if (!entry) {
      throw new ChangelogServiceError(404, 'NOT_FOUND', 'Changelog entry not found');
   }
   return entry;
}

function isVisible(entry: ChangelogEntryRow, now: Date): boolean {
   return (
      VISIBLE_STATUSES.includes(entry.status) &&
      entry.publishedAt !== null &&
      entry.publishedAt <= now
   );
}

/** Creates a DRAFT entry. Drafts are never public. */
export async function createDraftEntry(
   input: Required<Pick<ChangelogContentInput, 'title' | 'body' | 'category'>> &
      Pick<ChangelogContentInput, 'version' | 'url'>,
   adminId: string
): Promise<ChangelogEntryRow> {
   const content = sanitizeContent(input);
   return (await prisma.changelogEntry.create({
      data: {
         title: content.title as string,
         body: content.body as string,
         category: content.category as ChangelogCategory,
         version: content.version ?? null,
         url: content.url ?? null,
         status: 'DRAFT',
         createdBy: adminId,
      },
   })) as ChangelogEntryRow;
}

/** Edits content. Invalidates the public cache when the entry is or will be public. */
export async function updateEntry(id: string, input: ChangelogContentInput): Promise<ChangelogEntryRow> {
   await getEntryOrThrow(id);
   const content = sanitizeContent(input);
   const updated = (await prisma.changelogEntry.update({
      where: { id },
      data: content,
   })) as ChangelogEntryRow;
   if (updated.status !== 'DRAFT') await invalidateChangelogCache();
   return updated;
}

/** Schedules a draft (or reschedules a pending entry) for a future time. */
export async function scheduleEntry(
   id: string,
   publishAt: Date,
   now: Date = new Date()
): Promise<ChangelogEntryRow> {
   const entry = await getEntryOrThrow(id);
   if (publishAt <= now) {
      throw new ChangelogServiceError(400, 'VALIDATION_ERROR', 'publishAt must be in the future');
   }
   if (entry.status === 'PUBLISHED' || isVisible(entry, now)) {
      throw new ChangelogServiceError(409, 'CONFLICT', 'Entry is already public');
   }
   const updated = (await prisma.changelogEntry.update({
      where: { id },
      data: { status: 'SCHEDULED', publishedAt: publishAt },
   })) as ChangelogEntryRow;
   // The new go-live time may be sooner than an existing cache entry's TTL.
   await invalidateChangelogCache();
   return updated;
}

/**
 * Publishes now. A scheduled entry whose time already passed keeps its
 * original `publishedAt`, so readers who saw it are not shown it as new again.
 */
export async function publishEntry(id: string, now: Date = new Date()): Promise<ChangelogEntryRow> {
   const entry = await getEntryOrThrow(id);
   if (entry.status === 'PUBLISHED') {
      throw new ChangelogServiceError(409, 'CONFLICT', 'Entry is already published');
   }
   const publishedAt = isVisible(entry, now) ? (entry.publishedAt as Date) : now;
   const updated = (await prisma.changelogEntry.update({
      where: { id },
      data: { status: 'PUBLISHED', publishedAt },
   })) as ChangelogEntryRow;
   await invalidateChangelogCache();
   return updated;
}

/** Admin listing including drafts, newest created first. */
export async function listAdminEntries(params: {
   status?: ChangelogStatus;
   cursor?: string;
   limit?: number;
}): Promise<{ entries: ChangelogEntryRow[]; nextCursor: string | null }> {
   const limit = clampLimit(params.limit);
   const rows = (await prisma.changelogEntry.findMany({
      where: params.status ? { status: params.status } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
   })) as ChangelogEntryRow[];
   const page = rows.slice(0, limit);
   return {
      entries: page,
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
   };
}
