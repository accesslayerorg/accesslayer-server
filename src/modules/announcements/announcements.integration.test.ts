// src/modules/announcements/announcements.integration.test.ts

const mockCreatorProfileFindFirst = jest.fn();
const mockAnnouncementFindUnique = jest.fn();
const mockAnnouncementFindMany = jest.fn();
const mockAnnouncementCreate = jest.fn();
const mockAnnouncementUpdate = jest.fn();

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: (...args: unknown[]) => mockCreatorProfileFindFirst(...args),
      },
      stellarWallet: {
         findUnique: jest.fn(),
      },
      announcement: {
         findUnique: (...args: unknown[]) => mockAnnouncementFindUnique(...args),
         findMany: (...args: unknown[]) => mockAnnouncementFindMany(...args),
         create: (...args: unknown[]) => mockAnnouncementCreate(...args),
         update: (...args: unknown[]) => mockAnnouncementUpdate(...args),
      },
      auditEvent: {
         create: jest.fn().mockResolvedValue({}),
      },
   },
}));

import request from 'supertest';
import app from '../../app';
import * as walletOwnershipUtils from '../../utils/wallet-ownership.utils';
import * as coCreatorService from '../co-creators/co-creators.service';
import { announcementEventEmitter } from './announcements.service';
import { AnnouncementStatus } from './announcements.types';

describe('Announcements API Endpoints', () => {
   const creatorWallet = 'GCREATORWALLET1111111111111111111111111111111111111111';
   const contentCoCreatorWallet = 'GCONTENTCOCREATOR1111111111111111111111111111111111111';
   const adminCoCreatorWallet = 'GADMINCOCREATOR111111111111111111111111111111111111111';
   const revenueCoCreatorWallet = 'GREVENUECOCREATOR1111111111111111111111111111111111111';
   const nonCreatorWallet = 'GNONCREATORWALLET1111111111111111111111111111111111111';
   const keyId = 'key-test-123';

   beforeEach(() => {
      jest.clearAllMocks();
      mockCreatorProfileFindFirst.mockReset();
      mockAnnouncementFindUnique.mockReset();
      mockAnnouncementFindMany.mockReset();
      mockAnnouncementCreate.mockReset();
      mockAnnouncementUpdate.mockReset();

      // Mock creator profile lookup
      mockCreatorProfileFindFirst.mockResolvedValue({
         id: keyId,
         handle: 'testcreator',
      });

      // Default mock for checkCreatorProfileOwnership
      jest
         .spyOn(walletOwnershipUtils, 'checkCreatorProfileOwnership')
         .mockImplementation(async (address: string, targetKeyId: string) => {
            if (address === creatorWallet && targetKeyId === keyId) {
               return { status: 'granted', ownerUserId: 'user-1' };
            }
            return {
               status: 'forbidden',
               address,
               ownerUserId: 'user-other',
            };
         });

      // Default mock for getCoCreatorDetail
      jest
         .spyOn(coCreatorService, 'getCoCreatorDetail')
         .mockImplementation(async (targetKeyId: string, wallet: string) => {
            if (targetKeyId !== keyId) return null;
            if (wallet === contentCoCreatorWallet) {
               return {
                  key_id: keyId,
                  wallet,
                  role: 'CONTENT',
                  active: true,
                  added_at: new Date().toISOString(),
                  removed_at: null,
                  share_bps: 100,
               };
            }
            if (wallet === adminCoCreatorWallet) {
               return {
                  key_id: keyId,
                  wallet,
                  role: 'ADMIN',
                  active: true,
                  added_at: new Date().toISOString(),
                  removed_at: null,
                  share_bps: 100,
               };
            }
            if (wallet === revenueCoCreatorWallet) {
               return {
                  key_id: keyId,
                  wallet,
                  role: 'REVENUE',
                  active: true,
                  added_at: new Date().toISOString(),
                  removed_at: null,
                  share_bps: 100,
               };
            }
            return null;
         });
   });

   describe('POST /v1/keys/:keyId/announcements', () => {
      it('returns 403 when called by a non-creator', async () => {
         const scheduledAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
         const res = await request(app)
            .post(`/v1/keys/${keyId}/announcements`)
            .set('x-wallet-address', nonCreatorWallet)
            .send({
               content: 'Unauthorized announcement',
               scheduledAt,
            });

         expect(res.status).toBe(403);
         expect(res.body.success).toBe(false);
      });

      it('returns 403 when called by a co-creator with REVENUE role (only CONTENT / ADMIN allowed)', async () => {
         const scheduledAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
         const res = await request(app)
            .post(`/v1/keys/${keyId}/announcements`)
            .set('x-wallet-address', revenueCoCreatorWallet)
            .send({
               content: 'Revenue co-creator announcement',
               scheduledAt,
            });

         expect(res.status).toBe(403);
      });

      it('returns 400 when scheduledAt is less than 5 minutes ahead', async () => {
         const scheduledAt = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 minutes ahead
         const res = await request(app)
            .post(`/v1/keys/${keyId}/announcements`)
            .set('x-wallet-address', creatorWallet)
            .send({
               content: 'Too soon',
               scheduledAt,
            });

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.message).toContain('at least 5 minutes');
      });

      it('returns 400 when scheduledAt is in the past', async () => {
         const scheduledAt = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute in the past
         const res = await request(app)
            .post(`/v1/keys/${keyId}/announcements`)
            .set('x-wallet-address', creatorWallet)
            .send({
               content: 'In the past',
               scheduledAt,
            });

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
      });

      it('returns 400 when scheduledAt is more than 90 days ahead', async () => {
         const scheduledAt = new Date(
            Date.now() + 91 * 24 * 60 * 60 * 1000
         ).toISOString(); // 91 days
         const res = await request(app)
            .post(`/v1/keys/${keyId}/announcements`)
            .set('x-wallet-address', creatorWallet)
            .send({
               content: 'Too far in future',
               scheduledAt,
            });

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.message).toContain('at most 90 days ahead');
      });

      it('returns 400 when scheduledAt is an invalid date string', async () => {
         const res = await request(app)
            .post(`/v1/keys/${keyId}/announcements`)
            .set('x-wallet-address', creatorWallet)
            .send({
               content: 'Invalid date string',
               scheduledAt: 'invalid-date-format',
            });

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
      });

      it('successfully schedules announcement when scheduledAt is valid (creator)', async () => {
         const targetDate = new Date(Date.now() + 10 * 60 * 1000);
         const scheduledAt = targetDate.toISOString();

         mockAnnouncementCreate.mockResolvedValueOnce({
            id: 'ann-1',
            keyId,
            content: 'Upcoming launch announcement',
            scheduledAt: targetDate,
            status: AnnouncementStatus.scheduled,
            publishedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
         });

         const res = await request(app)
            .post(`/v1/keys/${keyId}/announcements`)
            .set('x-wallet-address', creatorWallet)
            .send({
               content: 'Upcoming launch announcement',
               scheduledAt,
            });

         expect(res.status).toBe(201);
         expect(res.body.success).toBe(true);
         expect(res.body.data.status).toBe('scheduled');
         expect(res.body.data.content).toBe('Upcoming launch announcement');
         expect(res.body.data.scheduledAt).toBeDefined();
      });

      it('successfully schedules announcement when called by active co-creator with CONTENT role', async () => {
         const targetDate = new Date(Date.now() + 20 * 60 * 1000);
         const scheduledAt = targetDate.toISOString();

         mockAnnouncementCreate.mockResolvedValueOnce({
            id: 'ann-co-1',
            keyId,
            content: 'Co-creator scheduled post',
            scheduledAt: targetDate,
            status: AnnouncementStatus.scheduled,
            publishedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
         });

         const res = await request(app)
            .post(`/v1/keys/${keyId}/announcements`)
            .set('x-wallet-address', contentCoCreatorWallet)
            .send({
               content: 'Co-creator scheduled post',
               scheduledAt,
            });

         expect(res.status).toBe(201);
         expect(res.body.success).toBe(true);
         expect(res.body.data.status).toBe('scheduled');
      });

      it('successfully schedules announcement when called by active co-creator with ADMIN role', async () => {
         const targetDate = new Date(Date.now() + 25 * 60 * 1000);
         const scheduledAt = targetDate.toISOString();

         mockAnnouncementCreate.mockResolvedValueOnce({
            id: 'ann-admin-1',
            keyId,
            content: 'Admin co-creator scheduled post',
            scheduledAt: targetDate,
            status: AnnouncementStatus.scheduled,
            publishedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
         });

         const res = await request(app)
            .post(`/v1/keys/${keyId}/announcements`)
            .set('x-wallet-address', adminCoCreatorWallet)
            .send({
               content: 'Admin co-creator scheduled post',
               scheduledAt,
            });

         expect(res.status).toBe(201);
         expect(res.body.success).toBe(true);
         expect(res.body.data.status).toBe('scheduled');
      });

      it('successfully publishes immediately when scheduledAt is omitted and emits announcement.published', async () => {
         const emitSpy = jest.spyOn(announcementEventEmitter, 'emit');

         mockAnnouncementCreate.mockResolvedValueOnce({
            id: 'ann-immediate-1',
            keyId,
            content: 'Immediate post',
            scheduledAt: null,
            status: AnnouncementStatus.published,
            publishedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
         });

         const res = await request(app)
            .post(`/v1/keys/${keyId}/announcements`)
            .set('x-wallet-address', creatorWallet)
            .send({
               content: 'Immediate post',
            });

         expect(res.status).toBe(201);
         expect(res.body.success).toBe(true);
         expect(res.body.data.status).toBe('published');
         expect(res.body.data.publishedAt).toBeDefined();

         expect(emitSpy).toHaveBeenCalledWith(
            'announcement.published',
            expect.objectContaining({
               id: 'ann-immediate-1',
               status: 'published',
            })
         );
      });
   });

   describe('PATCH /v1/announcements/:id', () => {
      const scheduledAnnouncement = {
         id: 'ann-scheduled-100',
         keyId,
         content: 'Original content',
         scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
         status: AnnouncementStatus.scheduled,
         publishedAt: null,
         createdAt: new Date(),
         updatedAt: new Date(),
      };

      it('returns 403 when called by a non-creator', async () => {
         mockAnnouncementFindUnique.mockResolvedValueOnce(scheduledAnnouncement);

         const res = await request(app)
            .patch('/v1/announcements/ann-scheduled-100')
            .set('x-wallet-address', nonCreatorWallet)
            .send({
               content: 'Hacked content',
            });

         expect(res.status).toBe(403);
         expect(res.body.success).toBe(false);
      });

      it('returns 404 when announcement does not exist', async () => {
         mockAnnouncementFindUnique.mockResolvedValueOnce(null);

         const res = await request(app)
            .patch('/v1/announcements/ann-non-existent')
            .set('x-wallet-address', creatorWallet)
            .send({
               content: 'New content',
            });

         expect(res.status).toBe(404);
         expect(res.body.success).toBe(false);
      });

      it('allows key creator to edit content while status is scheduled', async () => {
         mockAnnouncementFindUnique.mockResolvedValueOnce(scheduledAnnouncement);
         mockAnnouncementUpdate.mockResolvedValueOnce({
            ...scheduledAnnouncement,
            content: 'Updated content',
         });

         const res = await request(app)
            .patch('/v1/announcements/ann-scheduled-100')
            .set('x-wallet-address', creatorWallet)
            .send({
               content: 'Updated content',
            });

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.content).toBe('Updated content');
      });

      it('allows key creator to cancel announcement while status is scheduled', async () => {
         mockAnnouncementFindUnique.mockResolvedValueOnce(scheduledAnnouncement);
         mockAnnouncementUpdate.mockResolvedValueOnce({
            ...scheduledAnnouncement,
            status: AnnouncementStatus.cancelled,
         });

         const res = await request(app)
            .patch('/v1/announcements/ann-scheduled-100')
            .set('x-wallet-address', creatorWallet)
            .send({
               status: 'cancelled',
            });

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.status).toBe('cancelled');
      });

      it('allows rescheduling while status is scheduled and validates 5m-90d range', async () => {
         mockAnnouncementFindUnique.mockResolvedValueOnce(scheduledAnnouncement);

         // Try invalid reschedule (1 minute ahead -> outside allowed range)
         const invalidReschedule = new Date(Date.now() + 60 * 1000).toISOString();
         const res = await request(app)
            .patch('/v1/announcements/ann-scheduled-100')
            .set('x-wallet-address', creatorWallet)
            .send({
               scheduledAt: invalidReschedule,
            });

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);

         // Valid reschedule (30 minutes ahead)
         const validReschedule = new Date(Date.now() + 30 * 60 * 1000);
         mockAnnouncementFindUnique.mockResolvedValueOnce(scheduledAnnouncement);
         mockAnnouncementUpdate.mockResolvedValueOnce({
            ...scheduledAnnouncement,
            scheduledAt: validReschedule,
         });

         const resValid = await request(app)
            .patch('/v1/announcements/ann-scheduled-100')
            .set('x-wallet-address', creatorWallet)
            .send({
               scheduledAt: validReschedule.toISOString(),
            });

         expect(resValid.status).toBe(200);
         expect(resValid.body.success).toBe(true);
      });

      it('returns 400 when attempting to edit or cancel an announcement that is already published', async () => {
         const publishedAnnouncement = {
            ...scheduledAnnouncement,
            status: AnnouncementStatus.published,
            publishedAt: new Date(),
         };
         mockAnnouncementFindUnique.mockResolvedValueOnce(publishedAnnouncement);

         const res = await request(app)
            .patch('/v1/announcements/ann-scheduled-100')
            .set('x-wallet-address', creatorWallet)
            .send({
               content: 'Trying to change published post',
            });

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.message).toContain('only be edited or cancelled while scheduled');
      });

      it('returns 400 when attempting to edit or cancel an announcement that is already cancelled', async () => {
         const alreadyCancelled = {
            ...scheduledAnnouncement,
            status: AnnouncementStatus.cancelled,
         };
         mockAnnouncementFindUnique.mockResolvedValueOnce(alreadyCancelled);

         const res = await request(app)
            .patch('/v1/announcements/ann-scheduled-100')
            .set('x-wallet-address', creatorWallet)
            .send({
               status: 'cancelled',
            });

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error.message).toContain('only be edited or cancelled while scheduled');
      });
   });
});
