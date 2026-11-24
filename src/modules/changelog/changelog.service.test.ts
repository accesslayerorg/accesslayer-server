// src/modules/changelog/changelog.service.test.ts

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      changelogEntry: {
         findMany: jest.fn(),
         findFirst: jest.fn(),
         findUnique: jest.fn(),
         count: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
      },
      changelogRead: {
         findUnique: jest.fn(),
         upsert: jest.fn(),
      },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
   cacheInvalidate: jest.fn(),
}));

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheInvalidate, cacheSetJson } from '../../utils/redis.utils';
import { decodeCursor, encodeCursor } from '../../utils/cursor.utils';
import {
   CHANGELOG_CACHE_PREFIX,
   ChangelogServiceError,
   changelogCacheTtlSeconds,
   createDraftEntry,
   getUnreadCount,
   listPublishedEntries,
   markAllRead,
   publishEntry,
   scheduleEntry,
   updateEntry,
   visibleEntryWhere,
} from './changelog.service';

const db = prisma as any;
const NOW = new Date('2026-11-24T12:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
   return {
      id: 'e1',
      title: 'Faster swaps',
      body: 'Swaps settle sooner.',
      category: 'IMPROVED',
      status: 'PUBLISHED',
      version: '2026.11',
      url: null,
      publishedAt: new Date('2026-11-20T00:00:00.000Z'),
      createdBy: 'admin-1',
      createdAt: new Date('2026-11-19T00:00:00.000Z'),
      updatedAt: new Date('2026-11-20T00:00:00.000Z'),
      ...overrides,
   };
}

beforeEach(() => {
   jest.clearAllMocks();
   (cacheGetJson as jest.Mock).mockResolvedValue(null);
   db.changelogEntry.findFirst.mockResolvedValue(null);
});

describe('visibility', () => {
   it('treats PUBLISHED and due SCHEDULED entries as public, never drafts or future schedules', () => {
      expect(visibleEntryWhere(NOW)).toEqual({
         status: { in: ['PUBLISHED', 'SCHEDULED'] },
         publishedAt: { lte: NOW },
      });
      expect(visibleEntryWhere(NOW, 'FIXED')).toMatchObject({ category: 'FIXED' });
   });

   it('passes the visibility filter and newest-first ordering to the query', async () => {
      db.changelogEntry.findMany.mockResolvedValue([]);
      await listPublishedEntries({ now: NOW, category: 'NEW' });
      const args = db.changelogEntry.findMany.mock.calls[0][0];
      expect(args.where.AND[0]).toEqual(visibleEntryWhere(NOW, 'NEW'));
      expect(args.orderBy).toEqual([{ publishedAt: 'desc' }, { id: 'desc' }]);
   });
});

describe('cache TTL', () => {
   it('uses 5 minutes when nothing is scheduled', () => {
      expect(changelogCacheTtlSeconds(NOW, null)).toBe(300);
   });

   it('expires when the next scheduled entry goes live', () => {
      expect(changelogCacheTtlSeconds(NOW, new Date(NOW.getTime() + 90_000))).toBe(90);
   });

   it('never exceeds 5 minutes for distant schedules', () => {
      expect(changelogCacheTtlSeconds(NOW, new Date(NOW.getTime() + 86_400_000))).toBe(300);
   });

   it('does not cache when an entry goes live within a second', () => {
      expect(changelogCacheTtlSeconds(NOW, new Date(NOW.getTime() + 400))).toBe(0);
   });

   it('caches the page with the capped TTL', async () => {
      db.changelogEntry.findMany.mockResolvedValue([row()]);
      db.changelogEntry.findFirst.mockResolvedValue({
         publishedAt: new Date(NOW.getTime() + 60_000),
      });
      await listPublishedEntries({ now: NOW });
      expect(cacheSetJson).toHaveBeenCalledWith(
         `${CHANGELOG_CACHE_PREFIX}all:20:first`,
         expect.objectContaining({ entries: [expect.objectContaining({ id: 'e1' })] }),
         60
      );
   });

   it('serves a cache hit without querying the database', async () => {
      const cached = { entries: [], nextCursor: null };
      (cacheGetJson as jest.Mock).mockResolvedValue(cached);
      await expect(listPublishedEntries({ now: NOW })).resolves.toBe(cached);
      expect(db.changelogEntry.findMany).not.toHaveBeenCalled();
   });
});

describe('cursor pagination', () => {
   it('returns a signed cursor for the last entry and resumes strictly after it', async () => {
      const rows = [
         row({ id: 'c', publishedAt: new Date('2026-11-22T00:00:00Z') }),
         row({ id: 'b', publishedAt: new Date('2026-11-21T00:00:00Z') }),
         row({ id: 'a', publishedAt: new Date('2026-11-21T00:00:00Z') }),
      ];
      db.changelogEntry.findMany.mockResolvedValueOnce(rows);
      const first = await listPublishedEntries({ now: NOW, limit: 2 });
      expect(first.entries.map(e => e.id)).toEqual(['c', 'b']);
      expect(decodeCursor(first.nextCursor as string)).toEqual({
         publishedAt: '2026-11-21T00:00:00.000Z',
         id: 'b',
      });

      db.changelogEntry.findMany.mockResolvedValueOnce([rows[2]]);
      const second = await listPublishedEntries({
         now: NOW,
         limit: 2,
         cursor: first.nextCursor as string,
      });
      expect(second).toEqual({ entries: [expect.objectContaining({ id: 'a' })], nextCursor: null });
      expect(db.changelogEntry.findMany.mock.calls[1][0].where.AND[1]).toEqual({
         OR: [
            { publishedAt: { lt: new Date('2026-11-21T00:00:00.000Z') } },
            { publishedAt: new Date('2026-11-21T00:00:00.000Z'), id: { lt: 'b' } },
         ],
      });
   });

   it('rejects tampered or malformed cursors with 400', async () => {
      const forged = encodeCursor({ id: 'x', publishedAt: 'not-a-date' });
      for (const cursor of ['garbage', `${forged.split('.')[0]}.deadbeef`, forged]) {
         await expect(listPublishedEntries({ now: NOW, cursor })).rejects.toMatchObject({
            statusCode: 400,
         });
      }
   });
});

describe('unread tracking', () => {
   it('counts every visible entry for a wallet that never opened the feed', async () => {
      db.changelogRead.findUnique.mockResolvedValue(null);
      db.changelogEntry.count.mockResolvedValue(4);
      await expect(getUnreadCount('GWALLET', NOW)).resolves.toBe(4);
      expect(db.changelogEntry.count).toHaveBeenCalledWith({ where: visibleEntryWhere(NOW) });
   });

   it('counts only entries published after the last read', async () => {
      const lastReadAt = new Date('2026-11-21T00:00:00Z');
      db.changelogRead.findUnique.mockResolvedValue({ lastReadAt });
      db.changelogEntry.count.mockResolvedValue(1);
      await expect(getUnreadCount('GWALLET', NOW)).resolves.toBe(1);
      expect(db.changelogEntry.count).toHaveBeenCalledWith({
         where: {
            status: { in: ['PUBLISHED', 'SCHEDULED'] },
            publishedAt: { gt: lastReadAt, lte: NOW },
         },
      });
   });

   it('marking read stores the read time and reports zero unread', async () => {
      db.changelogRead.upsert.mockResolvedValue({});
      await expect(markAllRead('GWALLET', NOW)).resolves.toEqual({
         lastReadAt: NOW.toISOString(),
         unreadCount: 0,
      });
      expect(db.changelogRead.upsert).toHaveBeenCalledWith({
         where: { walletAddress: 'GWALLET' },
         create: { walletAddress: 'GWALLET', lastReadAt: NOW },
         update: { lastReadAt: NOW },
      });
   });
});

describe('admin workflow', () => {
   it('creates drafts with sanitized content', async () => {
      db.changelogEntry.create.mockImplementation(async ({ data }: any) => ({ id: 'n', ...data }));
      const entry = await createDraftEntry(
         {
            title: '<b>New</b> charts',
            body: 'Charts <script>alert(1)</script>[more](javascript:alert(1))',
            category: 'NEW',
         },
         'admin-1'
      );
      expect(entry).toMatchObject({
         title: 'New charts',
         body: 'Charts [more](#)',
         status: 'DRAFT',
         createdBy: 'admin-1',
      });
   });

   it('rejects a body that is empty after sanitization', async () => {
      await expect(
         createDraftEntry({ title: 'x', body: '<script>alert(1)</script>', category: 'NEW' }, 'a')
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(db.changelogEntry.create).not.toHaveBeenCalled();
   });

   it('schedules only for the future and invalidates the cache', async () => {
      db.changelogEntry.findUnique.mockResolvedValue(row({ status: 'DRAFT', publishedAt: null }));
      await expect(scheduleEntry('e1', new Date(NOW.getTime() - 1), NOW)).rejects.toMatchObject({
         statusCode: 400,
      });

      const at = new Date(NOW.getTime() + 3_600_000);
      db.changelogEntry.update.mockResolvedValue(row({ status: 'SCHEDULED', publishedAt: at }));
      await scheduleEntry('e1', at, NOW);
      expect(db.changelogEntry.update).toHaveBeenCalledWith({
         where: { id: 'e1' },
         data: { status: 'SCHEDULED', publishedAt: at },
      });
      expect(cacheInvalidate).toHaveBeenCalledWith(`${CHANGELOG_CACHE_PREFIX}*`);
   });

   it('refuses to reschedule an entry that is already public', async () => {
      db.changelogEntry.findUnique.mockResolvedValue(row());
      await expect(
         scheduleEntry('e1', new Date(NOW.getTime() + 60_000), NOW)
      ).rejects.toBeInstanceOf(ChangelogServiceError);
   });

   it('publishes a draft at the current time and invalidates the cache', async () => {
      db.changelogEntry.findUnique.mockResolvedValue(row({ status: 'DRAFT', publishedAt: null }));
      db.changelogEntry.update.mockResolvedValue(row({ publishedAt: NOW }));
      await publishEntry('e1', NOW);
      expect(db.changelogEntry.update).toHaveBeenCalledWith({
         where: { id: 'e1' },
         data: { status: 'PUBLISHED', publishedAt: NOW },
      });
      expect(cacheInvalidate).toHaveBeenCalledWith(`${CHANGELOG_CACHE_PREFIX}*`);
   });

   it('keeps the original time when publishing a scheduled entry that already went live', async () => {
      const wentLive = new Date(NOW.getTime() - 60_000);
      db.changelogEntry.findUnique.mockResolvedValue(
         row({ status: 'SCHEDULED', publishedAt: wentLive })
      );
      db.changelogEntry.update.mockResolvedValue(row({ publishedAt: wentLive }));
      await publishEntry('e1', NOW);
      expect(db.changelogEntry.update.mock.calls[0][0].data).toEqual({
         status: 'PUBLISHED',
         publishedAt: wentLive,
      });
   });

   it('publishes a future-scheduled entry immediately', async () => {
      db.changelogEntry.findUnique.mockResolvedValue(
         row({ status: 'SCHEDULED', publishedAt: new Date(NOW.getTime() + 60_000) })
      );
      db.changelogEntry.update.mockResolvedValue(row({ publishedAt: NOW }));
      await publishEntry('e1', NOW);
      expect(db.changelogEntry.update.mock.calls[0][0].data.publishedAt).toEqual(NOW);
   });

   it('rejects publishing twice with 409 and missing entries with 404', async () => {
      db.changelogEntry.findUnique.mockResolvedValueOnce(row());
      await expect(publishEntry('e1', NOW)).rejects.toMatchObject({ statusCode: 409 });
      db.changelogEntry.findUnique.mockResolvedValueOnce(null);
      await expect(publishEntry('missing', NOW)).rejects.toMatchObject({ statusCode: 404 });
   });

   it('sanitizes updates and only invalidates the cache for non-draft entries', async () => {
      db.changelogEntry.findUnique.mockResolvedValue(row({ status: 'DRAFT', publishedAt: null }));
      db.changelogEntry.update.mockResolvedValue(row({ status: 'DRAFT' }));
      await updateEntry('e1', { body: 'Hi <img src=x onerror=alert(1)>there' });
      expect(db.changelogEntry.update).toHaveBeenCalledWith({
         where: { id: 'e1' },
         data: { body: 'Hi there' },
      });
      expect(cacheInvalidate).not.toHaveBeenCalled();

      db.changelogEntry.update.mockResolvedValue(row());
      await updateEntry('e1', { title: 'Renamed' });
      expect(cacheInvalidate).toHaveBeenCalledTimes(1);
   });
});
