// src/modules/changelog/changelog.routes.test.ts
// Exercises the real adminGuard and requireJwtAuth middleware with signed tokens.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

jest.mock('./changelog.service', () => {
   const actual = jest.requireActual('./changelog.service');
   return {
      ...actual,
      listPublishedEntries: jest.fn(),
      getUnreadCount: jest.fn(),
      markAllRead: jest.fn(),
      createDraftEntry: jest.fn(),
      updateEntry: jest.fn(),
      scheduleEntry: jest.fn(),
      publishEntry: jest.fn(),
      listAdminEntries: jest.fn(),
   };
});

jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { envConfig } from '../../config';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import { changelogAdminRouter, changelogRouter } from './changelog.routes';
import {
   ChangelogServiceError,
   createDraftEntry,
   getUnreadCount,
   listPublishedEntries,
   markAllRead,
   publishEntry,
   scheduleEntry,
} from './changelog.service';

const app = express();
app.use(express.json());
app.use('/v1/changelog', changelogRouter);
app.use('/v1/admin/changelog', changelogAdminRouter);

const WALLET = 'GCHANGELOGREADERWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const walletToken = signWalletAccessToken(WALLET);
const adminToken = jwt.sign({ adminId: 'admin-1', role: 'admin' }, envConfig.JWT_SECRET);
const nonAdminToken = jwt.sign({ adminId: 'user-1', role: 'user' }, envConfig.JWT_SECRET);

beforeEach(() => jest.clearAllMocks());

describe('GET /v1/changelog', () => {
   it('returns the public page and accepts a case-insensitive category', async () => {
      (listPublishedEntries as jest.Mock).mockResolvedValue({ entries: [], nextCursor: null });
      const res = await request(app).get('/v1/changelog?category=fixed&limit=5');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ entries: [], nextCursor: null });
      expect(listPublishedEntries).toHaveBeenCalledWith({ category: 'FIXED', limit: 5 });
   });

   it('rejects unknown categories', async () => {
      const res = await request(app).get('/v1/changelog?category=breaking');
      expect(res.status).toBe(400);
      expect(listPublishedEntries).not.toHaveBeenCalled();
   });

   it('maps an invalid cursor to 400', async () => {
      (listPublishedEntries as jest.Mock).mockRejectedValue(
         new ChangelogServiceError(400, 'VALIDATION_ERROR', 'Invalid cursor')
      );
      const res = await request(app).get('/v1/changelog?cursor=bad');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
   });
});

describe('unread tracking routes', () => {
   it('require a wallet token', async () => {
      expect((await request(app).get('/v1/changelog/unread-count')).status).toBe(401);
      expect((await request(app).post('/v1/changelog/read')).status).toBe(401);
      expect(getUnreadCount).not.toHaveBeenCalled();
      expect(markAllRead).not.toHaveBeenCalled();
   });

   it('report and clear the unread count for the token wallet', async () => {
      (getUnreadCount as jest.Mock).mockResolvedValue(3);
      const count = await request(app)
         .get('/v1/changelog/unread-count')
         .set('Authorization', `Bearer ${walletToken}`);
      expect(count.status).toBe(200);
      expect(count.body.data).toEqual({ unreadCount: 3 });
      expect(getUnreadCount).toHaveBeenCalledWith(WALLET);

      (markAllRead as jest.Mock).mockResolvedValue({ lastReadAt: 'now', unreadCount: 0 });
      const read = await request(app)
         .post('/v1/changelog/read')
         .set('Authorization', `Bearer ${walletToken}`);
      expect(read.status).toBe(200);
      expect(read.body.data.unreadCount).toBe(0);
      expect(markAllRead).toHaveBeenCalledWith(WALLET);
   });
});

describe('admin routes', () => {
   const draft = { title: 'New charts', body: 'Charts are live.', category: 'NEW' };

   it.each([
      ['no token', undefined, 401],
      ['a wallet token', walletToken, 403],
      ['a non-admin role', nonAdminToken, 403],
   ])('reject %s', async (_label, token, status) => {
      for (const call of [
         request(app).post('/v1/admin/changelog').send(draft),
         request(app).post('/v1/admin/changelog/e1/publish'),
         request(app).post('/v1/admin/changelog/e1/schedule').send({ publishAt: '2030-01-01T00:00:00Z' }),
         request(app).patch('/v1/admin/changelog/e1').send({ title: 'x' }),
         request(app).get('/v1/admin/changelog'),
      ]) {
         const res = await (token ? call.set('Authorization', `Bearer ${token}`) : call);
         expect(res.status).toBe(status);
      }
      expect(createDraftEntry).not.toHaveBeenCalled();
      expect(publishEntry).not.toHaveBeenCalled();
   });

   it('lets an admin create a draft, attributing it to the admin id', async () => {
      (createDraftEntry as jest.Mock).mockResolvedValue({ id: 'e1', ...draft, status: 'DRAFT' });
      const res = await request(app)
         .post('/v1/admin/changelog')
         .set('Authorization', `Bearer ${adminToken}`)
         .send({ ...draft, category: 'new' });
      expect(res.status).toBe(201);
      expect(createDraftEntry).toHaveBeenCalledWith(draft, 'admin-1');
   });

   it('validates the draft payload and the link scheme', async () => {
      const res = await request(app)
         .post('/v1/admin/changelog')
         .set('Authorization', `Bearer ${adminToken}`)
         .send({ ...draft, url: 'javascript:alert(1)' });
      expect(res.status).toBe(400);
      expect(createDraftEntry).not.toHaveBeenCalled();
   });

   it('schedules with an ISO time and publishes', async () => {
      (scheduleEntry as jest.Mock).mockResolvedValue({ id: 'e1', status: 'SCHEDULED' });
      const scheduled = await request(app)
         .post('/v1/admin/changelog/e1/schedule')
         .set('Authorization', `Bearer ${adminToken}`)
         .send({ publishAt: '2030-01-01T00:00:00Z' });
      expect(scheduled.status).toBe(200);
      expect(scheduleEntry).toHaveBeenCalledWith('e1', new Date('2030-01-01T00:00:00Z'));

      (publishEntry as jest.Mock).mockRejectedValue(
         new ChangelogServiceError(409, 'CONFLICT', 'Entry is already published')
      );
      const published = await request(app)
         .post('/v1/admin/changelog/e1/publish')
         .set('Authorization', `Bearer ${adminToken}`);
      expect(published.status).toBe(409);
   });
});
