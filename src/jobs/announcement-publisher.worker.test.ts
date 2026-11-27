// src/jobs/announcement-publisher.worker.test.ts

import EventEmitter from 'events';
import {
   AnnouncementPublisherWorker,
   DEFAULT_ANNOUNCEMENT_POLL_INTERVAL_MS,
} from './announcement-publisher.worker';
import { AnnouncementStatus } from '../modules/announcements/announcements.types';
import type { Announcement } from '@prisma/client';

describe('AnnouncementPublisherWorker', () => {
   const now = new Date('2026-11-20T12:00:00.000Z');

   const dueAnnouncement: Announcement = {
      id: 'announcement-due-1',
      keyId: 'key-1',
      content: 'Due announcement',
      scheduledAt: new Date('2026-11-20T11:55:00.000Z'), // in past
      status: AnnouncementStatus.scheduled,
      publishedAt: null,
      createdAt: new Date('2026-11-20T10:00:00.000Z'),
      updatedAt: new Date('2026-11-20T10:00:00.000Z'),
   };

   const futureAnnouncement: Announcement = {
      id: 'announcement-future-1',
      keyId: 'key-1',
      content: 'Future announcement',
      scheduledAt: new Date('2026-11-20T12:30:00.000Z'), // in future
      status: AnnouncementStatus.scheduled,
      publishedAt: null,
      createdAt: new Date('2026-11-20T10:00:00.000Z'),
      updatedAt: new Date('2026-11-20T10:00:00.000Z'),
   };

   const cancelledAnnouncement: Announcement = {
      id: 'announcement-cancelled-1',
      keyId: 'key-1',
      content: 'Cancelled announcement',
      scheduledAt: new Date('2026-11-20T11:50:00.000Z'), // past, but cancelled
      status: AnnouncementStatus.cancelled,
      publishedAt: null,
      createdAt: new Date('2026-11-20T10:00:00.000Z'),
      updatedAt: new Date('2026-11-20T10:00:00.000Z'),
   };

   it('publishes due scheduled announcements within one polling interval and emits event', async () => {
      const eventEmitter = new EventEmitter();
      const emittedEvents: any[] = [];
      eventEmitter.on('announcement.published', event => {
         emittedEvents.push(event);
      });

      const store: Announcement[] = [
         { ...dueAnnouncement },
         { ...futureAnnouncement },
         { ...cancelledAnnouncement },
      ];

      const fetchDueAndLock = jest.fn(async (currentDate: Date) => {
         return store.filter(
            r =>
               r.status === AnnouncementStatus.scheduled &&
               r.scheduledAt &&
               r.scheduledAt <= currentDate
         );
      });

      const markPublished = jest.fn(async (ids: string[], publishedAt: Date) => {
         for (const item of store) {
            if (ids.includes(item.id)) {
               item.status = AnnouncementStatus.published;
               item.publishedAt = publishedAt;
            }
         }
      });

      const worker = new AnnouncementPublisherWorker({
         now: () => now,
         eventEmitter,
         fetchDueAndLock,
         markPublished,
      });

      const published = await worker.pollOnce();

      expect(published).toHaveLength(1);
      expect(published[0].id).toBe('announcement-due-1');
      expect(published[0].status).toBe(AnnouncementStatus.published);
      expect(published[0].publishedAt).toEqual(now);

      expect(markPublished).toHaveBeenCalledWith(['announcement-due-1'], now);
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toEqual(
         expect.objectContaining({
            id: 'announcement-due-1',
            status: AnnouncementStatus.published,
            publishedAt: now,
         })
      );
   });

   it('never publishes future announcements', async () => {
      const eventEmitter = new EventEmitter();
      const emittedEvents: any[] = [];
      eventEmitter.on('announcement.published', event => {
         emittedEvents.push(event);
      });

      const store: Announcement[] = [{ ...futureAnnouncement }];

      const fetchDueAndLock = jest.fn(async (currentDate: Date) => {
         return store.filter(
            r =>
               r.status === AnnouncementStatus.scheduled &&
               r.scheduledAt &&
               r.scheduledAt <= currentDate
         );
      });

      const markPublished = jest.fn();

      const worker = new AnnouncementPublisherWorker({
         now: () => now,
         eventEmitter,
         fetchDueAndLock,
         markPublished,
      });

      const published = await worker.pollOnce();

      expect(published).toHaveLength(0);
      expect(markPublished).not.toHaveBeenCalled();
      expect(emittedEvents).toHaveLength(0);
   });

   it('never publishes cancelled announcements even if their scheduledAt is in the past', async () => {
      const eventEmitter = new EventEmitter();
      const emittedEvents: any[] = [];
      eventEmitter.on('announcement.published', event => {
         emittedEvents.push(event);
      });

      const store: Announcement[] = [{ ...cancelledAnnouncement }];

      const fetchDueAndLock = jest.fn(async (currentDate: Date) => {
         return store.filter(
            r =>
               r.status === AnnouncementStatus.scheduled &&
               r.scheduledAt &&
               r.scheduledAt <= currentDate
         );
      });

      const markPublished = jest.fn();

      const worker = new AnnouncementPublisherWorker({
         now: () => now,
         eventEmitter,
         fetchDueAndLock,
         markPublished,
      });

      const published = await worker.pollOnce();

      expect(published).toHaveLength(0);
      expect(markPublished).not.toHaveBeenCalled();
      expect(emittedEvents).toHaveLength(0);
   });

   it('two concurrent workers never publish the same row twice (SKIP LOCKED simulation)', async () => {
      const store: Announcement[] = [
         {
            ...dueAnnouncement,
            id: 'announcement-1',
         },
         {
            ...dueAnnouncement,
            id: 'announcement-2',
         },
      ];

      // Simulate PostgreSQL FOR UPDATE SKIP LOCKED with concurrency control
      const lockedIds = new Set<string>();

      const fetchDueAndLock = async (currentDate: Date, limit: number) => {
         const eligible = store.filter(
            r =>
               r.status === AnnouncementStatus.scheduled &&
               r.scheduledAt &&
               r.scheduledAt <= currentDate &&
               !lockedIds.has(r.id) // SKIP LOCKED behavior
         );
         const selected = eligible.slice(0, limit);
         for (const s of selected) {
            lockedIds.add(s.id);
         }
         return selected;
      };

      const markPublished = async (ids: string[], publishedAt: Date) => {
         for (const item of store) {
            if (ids.includes(item.id)) {
               item.status = AnnouncementStatus.published;
               item.publishedAt = publishedAt;
            }
         }
      };

      const worker1 = new AnnouncementPublisherWorker({
         batchSize: 1, // takes 1 row at a time
         now: () => now,
         fetchDueAndLock,
         markPublished,
      });

      const worker2 = new AnnouncementPublisherWorker({
         batchSize: 1, // takes 1 row at a time
         now: () => now,
         fetchDueAndLock,
         markPublished,
      });

      // Run both workers concurrently
      const [res1, res2] = await Promise.all([
         worker1.pollOnce(),
         worker2.pollOnce(),
      ]);

      expect(res1).toHaveLength(1);
      expect(res2).toHaveLength(1);

      // Verify each worker processed a DISTINCT row (no duplicates)
      expect(res1[0].id).not.toBe(res2[0].id);

      const allPublishedIds = [...res1, ...res2].map(r => r.id);
      expect(allPublishedIds).toContain('announcement-1');
      expect(allPublishedIds).toContain('announcement-2');

      // Run worker 1 again - should find 0 due rows
      const res3 = await worker1.pollOnce();
      expect(res3).toHaveLength(0);
   });

   it('supports starting and stopping the periodic 30-second polling timer', () => {
      jest.useFakeTimers();

      const worker = new AnnouncementPublisherWorker({
         pollingIntervalMs: DEFAULT_ANNOUNCEMENT_POLL_INTERVAL_MS,
      });

      expect(worker.pollingIntervalMs).toBe(30_000);
      expect(worker.isRunning()).toBe(false);

      worker.start();
      expect(worker.isRunning()).toBe(true);

      worker.stop();
      expect(worker.isRunning()).toBe(false);

      jest.useRealTimers();
   });
});
