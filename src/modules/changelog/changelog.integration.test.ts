// src/modules/changelog/changelog.integration.test.ts
// Product changelog against a real database (#1356).
//
// Run with: RUN_CHANGELOG_INTEGRATION=1 DATABASE_URL=... after `prisma db push`.

jest.unmock('@prisma/client');

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import { changelogAdminRouter, changelogRouter } from './changelog.routes';

const describeDatabase =
   process.env.RUN_CHANGELOG_INTEGRATION === '1' ? describe : describe.skip;

const fixture = `changelog-1356-${randomUUID()}`;
const wallet = `G${fixture.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 40)}`;
const adminToken = jwt.sign({ adminId: fixture, role: 'admin' }, envConfig.JWT_SECRET);
const walletToken = signWalletAccessToken(wallet);

const app = express();
app.use(express.json());
app.use('/v1/changelog', changelogRouter);
app.use('/v1/admin/changelog', changelogAdminRouter);

const admin = () => ({ Authorization: `Bearer ${adminToken}` });
const reader = () => ({ Authorization: `Bearer ${walletToken}` });

async function createDraft(title: string, body: string, category = 'NEW'): Promise<string> {
   const res = await request(app).post('/v1/admin/changelog').set(admin()).send({ title, body, category });
   expect(res.status).toBe(201);
   return res.body.data.entry.id;
}

async function publicIds(query = ''): Promise<string[]> {
   const res = await request(app).get(`/v1/changelog${query}`);
   expect(res.status).toBe(200);
   return res.body.data.entries.map((e: { id: string }) => e.id);
}

async function unread(): Promise<number> {
   const res = await request(app).get('/v1/changelog/unread-count').set(reader());
   expect(res.status).toBe(200);
   return res.body.data.unreadCount;
}

describeDatabase('product changelog database and HTTP lifecycle', () => {
   afterAll(async () => {
      await prisma.changelogEntry.deleteMany({ where: { createdBy: fixture } });
      await prisma.changelogRead.deleteMany({ where: { walletAddress: wallet } });
      await prisma.$disconnect();
   });

   it('sanitizes on save, hides drafts, publishes on time and tracks unread per wallet', async () => {
      const first = await createDraft(
         '<b>Faster</b> swaps',
         '> Swaps settle sooner & cost less.\n\n<script>alert(1)</script>[docs](javascript:alert(1))'
      );
      const stored = await prisma.changelogEntry.findUniqueOrThrow({ where: { id: first } });
      expect(stored.title).toBe('Faster swaps');
      expect(stored.body).toBe('> Swaps settle sooner & cost less.\n\n[docs](#)');

      // Drafts are not public and do not count as unread.
      expect(await publicIds()).not.toContain(first);
      expect(await unread()).toBe(0);

      expect((await request(app).post(`/v1/admin/changelog/${first}/publish`).set(admin())).status).toBe(200);
      expect(await publicIds()).toContain(first);
      expect(await unread()).toBe(1);

      // A scheduled entry is invisible until its time, then appears without any worker.
      const scheduled = await createDraft('Dark mode', 'Now with dark mode.', 'IMPROVED');
      const publishAt = new Date(Date.now() + 1500);
      const sched = await request(app)
         .post(`/v1/admin/changelog/${scheduled}/schedule`)
         .set(admin())
         .send({ publishAt: publishAt.toISOString() });
      expect(sched.status).toBe(200);
      expect(await publicIds()).not.toContain(scheduled);
      expect(await unread()).toBe(1);

      await new Promise(resolve => setTimeout(resolve, publishAt.getTime() - Date.now() + 200));
      expect(await publicIds()).toEqual(expect.arrayContaining([first, scheduled]));
      expect(await unread()).toBe(2);

      // Marking read clears the count; a later publish is unread again.
      const read = await request(app).post('/v1/changelog/read').set(reader());
      expect(read.status).toBe(200);
      expect(await unread()).toBe(0);

      const fix = await createDraft('Fixed rounding', 'Rounding fixed.', 'FIXED');
      await request(app).post(`/v1/admin/changelog/${fix}/publish`).set(admin());
      expect(await unread()).toBe(1);

      // Category filter and newest-first cursor pagination.
      expect(await publicIds('?category=fixed')).toEqual([fix]);
      const page1 = await request(app).get('/v1/changelog?limit=2');
      expect(page1.body.data.entries.map((e: { id: string }) => e.id)).toEqual([fix, scheduled]);
      const page2 = await request(app).get(
         `/v1/changelog?limit=2&cursor=${encodeURIComponent(page1.body.data.nextCursor)}`
      );
      expect(page2.body.data.entries.map((e: { id: string }) => e.id)).toEqual([first]);
      expect(page2.body.data.nextCursor).toBeNull();
   });
});
