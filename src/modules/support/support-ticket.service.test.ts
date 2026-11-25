jest.mock('../../config', () => ({
   envConfig: {
      JWT_SECRET: 'x'.repeat(48),
      BACKEND_URL: 'https://api.test',
      FRONTEND_URL: 'https://app.test',
   },
}));
jest.mock('../../utils/mail.utils', () => ({ SendMail: jest.fn().mockResolvedValue(true) }));
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      ticket: {
         create: jest.fn(),
         findFirst: jest.fn(),
         findMany: jest.fn(),
         count: jest.fn(),
         findUnique: jest.fn(),
         findUniqueOrThrow: jest.fn(),
         update: jest.fn(),
      },
      ticketMessage: { create: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
      ticketAttachment: { findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
      ticketStatusChange: { create: jest.fn() },
      user: { findUnique: jest.fn() },
      $transaction: jest.fn(),
   },
}));

import { SendMail } from '../../utils/mail.utils';
import { prisma } from '../../utils/prisma.utils';
import { signLink } from '../../utils/signed-url.utils';
import { AttachmentPolicyError } from './attachment-policy.utils';
import {
   addUserMessage,
   AttachmentUploadError,
   createSupportTicket,
   getUserTicket,
   InvalidStatusTransitionError,
   notifyUserOfAgentReply,
   replyAsAgent,
   setTicketStatus,
   storeAttachmentUpload,
   TicketClosedError,
   TicketNotFoundError,
} from './support-ticket.service';
import { ATTACHMENT_UPLOAD_PURPOSE } from './support.constants';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock };
const mockSend = SendMail as unknown as jest.Mock;
const NOW = new Date('2026-11-24T12:00:00Z');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('data')]);

const ticketRow = (overrides: Record<string, unknown> = {}) => ({
   id: 't1',
   userId: 'user-1',
   category: 'payments',
   subject: 'Payment missing',
   description: 'My payment did not arrive.',
   status: 'open',
   assigneeId: null,
   lastMessageAt: NOW,
   resolvedAt: null,
   closedAt: null,
   createdAt: NOW,
   updatedAt: NOW,
   ...overrides,
});

beforeEach(() => {
   jest.clearAllMocks();
   mockSend.mockResolvedValue(true);
});

describe('createSupportTicket', () => {
   it('rejects more than three attachments before writing anything', async () => {
      const four = Array.from({ length: 4 }, (_, index) => ({
         fileName: `f${index}.png`,
         contentType: 'image/png',
         sizeBytes: 10,
      }));
      await expect(
         createSupportTicket('user-1', {
            category: 'payments',
            subject: 'Payment missing',
            description: 'My payment did not arrive.',
            attachments: four,
         })
      ).rejects.toBeInstanceOf(AttachmentPolicyError);
      expect(db.ticket.create).not.toHaveBeenCalled();
   });

   it('creates the ticket with pending attachments and a signed upload link for each', async () => {
      db.ticket.create.mockResolvedValue(
         ticketRow({
            attachments: [
               { id: 'a1', fileName: 'shot.png', contentType: 'image/png', sizeBytes: 100, status: 'pending', uploadedAt: null },
            ],
         })
      );

      const result = await createSupportTicket(
         'user-1',
         {
            category: 'payments',
            subject: 'Payment missing',
            description: 'My payment did not arrive.',
            attachments: [{ fileName: 'shot.png', contentType: 'image/png', sizeBytes: 100 }],
         },
         NOW
      );

      const created = db.ticket.create.mock.calls[0][0].data;
      expect(created.userId).toBe('user-1');
      expect(created.attachments.create).toEqual([
         { fileName: 'shot.png', contentType: 'image/png', sizeBytes: 100 },
      ]);
      const expiresMs = NOW.getTime() + 15 * 60 * 1000;
      const sig = signLink(ATTACHMENT_UPLOAD_PURPOSE, 'a1', expiresMs);
      expect(result.uploads[0].uploadUrl).toBe(
         `https://api.test/v1/support/attachments/a1/upload?expires=${expiresMs}&sig=${sig}`
      );
      expect(result.ticket.status).toBe('open');
   });
});

describe('ticket ownership', () => {
   it('scopes a lookup to the caller so another user\'s ticket is not found', async () => {
      db.ticket.findFirst.mockResolvedValue(null);
      await expect(getUserTicket('user-2', 't1')).rejects.toBeInstanceOf(TicketNotFoundError);
      expect(db.ticket.findFirst).toHaveBeenCalledWith(
         expect.objectContaining({ where: { id: 't1', userId: 'user-2' } })
      );
   });
});

describe('addUserMessage', () => {
   it('refuses messages on a closed ticket', async () => {
      db.ticket.findFirst.mockResolvedValue({ id: 't1', status: 'closed' });
      await expect(addUserMessage('user-1', 't1', 'hello')).rejects.toBeInstanceOf(TicketClosedError);
      expect(db.$transaction).not.toHaveBeenCalled();
   });

   it('reopens a waiting ticket and records the change', async () => {
      db.ticket.findFirst.mockResolvedValue({ id: 't1', status: 'waiting' });
      const tx = {
         ticketMessage: {
            create: jest.fn().mockResolvedValue({ id: 'm1', authorType: 'user', body: 'hi', createdAt: NOW }),
         },
         ticket: { update: jest.fn() },
         ticketStatusChange: { create: jest.fn() },
      };
      db.$transaction.mockImplementation(async (callback: (t: typeof tx) => unknown) => callback(tx));

      const view = await addUserMessage('user-1', 't1', 'hi', NOW);

      expect(view.id).toBe('m1');
      expect(tx.ticket.update).toHaveBeenCalledWith({
         where: { id: 't1' },
         data: { lastMessageAt: NOW, status: 'open' },
      });
      expect(tx.ticketStatusChange.create).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({ fromStatus: 'waiting', toStatus: 'open', actorType: 'user' }),
         })
      );
   });
});

describe('storeAttachmentUpload', () => {
   const expiresMs = NOW.getTime() + 60_000;

   it('rejects an upload whose link signature does not verify', async () => {
      await expect(
         storeAttachmentUpload('a1', expiresMs, 'forged', PNG, NOW)
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(db.ticketAttachment.findUnique).not.toHaveBeenCalled();
   });

   it('stores valid bytes and marks the attachment uploaded', async () => {
      const sig = signLink(ATTACHMENT_UPLOAD_PURPOSE, 'a1', expiresMs);
      db.ticketAttachment.findUnique
         .mockResolvedValueOnce({ id: 'a1', status: 'pending', contentType: 'image/png', sizeBytes: PNG.length })
         .mockResolvedValueOnce({
            id: 'a1',
            fileName: 'shot.png',
            contentType: 'image/png',
            sizeBytes: PNG.length,
            status: 'uploaded',
            uploadedAt: NOW,
         });
      db.ticketAttachment.updateMany.mockResolvedValue({ count: 1 });

      const view = await storeAttachmentUpload('a1', expiresMs, sig, PNG, NOW);

      expect(view.status).toBe('uploaded');
      expect(db.ticketAttachment.updateMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { id: 'a1', status: 'pending' },
            data: expect.objectContaining({ status: 'uploaded', content: PNG, uploadedAt: NOW }),
         })
      );
   });

   it('refuses an executable disguised as an image with 422', async () => {
      const sig = signLink(ATTACHMENT_UPLOAD_PURPOSE, 'a1', expiresMs);
      const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
      db.ticketAttachment.findUnique.mockResolvedValueOnce({
         id: 'a1',
         status: 'pending',
         contentType: 'image/png',
         sizeBytes: exe.length,
      });

      await expect(storeAttachmentUpload('a1', expiresMs, sig, exe, NOW)).rejects.toMatchObject({
         statusCode: 422,
      });
      expect(db.ticketAttachment.updateMany).not.toHaveBeenCalled();
   });

   it('refuses a second upload for the same attachment with 409', async () => {
      const sig = signLink(ATTACHMENT_UPLOAD_PURPOSE, 'a1', expiresMs);
      db.ticketAttachment.findUnique.mockResolvedValueOnce({
         id: 'a1',
         status: 'uploaded',
         contentType: 'image/png',
         sizeBytes: PNG.length,
      });
      const error = await storeAttachmentUpload('a1', expiresMs, sig, PNG, NOW).catch(e => e);
      expect(error).toBeInstanceOf(AttachmentUploadError);
      expect(error.statusCode).toBe(409);
   });
});

describe('status changes', () => {
   it('refuses to reopen a closed ticket', async () => {
      db.ticket.findUnique.mockResolvedValue({ id: 't1', status: 'closed' });
      await expect(setTicketStatus('t1', 'admin-1', 'open', NOW)).rejects.toBeInstanceOf(
         InvalidStatusTransitionError
      );
   });

   it('stamps resolvedAt and records the change when resolving', async () => {
      db.ticket.findUnique.mockResolvedValue({ id: 't1', status: 'open' });
      const tx = { ticket: { update: jest.fn() }, ticketStatusChange: { create: jest.fn() } };
      db.$transaction.mockImplementation(async (callback: (t: typeof tx) => unknown) => callback(tx));
      db.ticket.findUniqueOrThrow.mockResolvedValue(ticketRow({ status: 'resolved', resolvedAt: NOW }));

      const view = await setTicketStatus('t1', 'admin-1', 'resolved', NOW);

      expect(view.status).toBe('resolved');
      expect(tx.ticket.update).toHaveBeenCalledWith({
         where: { id: 't1' },
         data: { status: 'resolved', resolvedAt: NOW },
      });
      expect(tx.ticketStatusChange.create).toHaveBeenCalledWith({
         data: expect.objectContaining({ fromStatus: 'open', toStatus: 'resolved', actorType: 'agent', actorId: 'admin-1' }),
      });
   });
});

describe('agent replies and notifications', () => {
   it('refuses to reply on a closed ticket', async () => {
      db.ticket.findUnique.mockResolvedValue({ id: 't1', status: 'closed' });
      await expect(replyAsAgent('t1', 'admin-1', { body: 'Hi' }, NOW)).rejects.toBeInstanceOf(
         TicketClosedError
      );
   });

   it('moves an open ticket to waiting and emails the owner once', async () => {
      db.ticket.findUnique
         .mockResolvedValueOnce({ id: 't1', status: 'open' })
         .mockResolvedValueOnce({ id: 't1', subject: 'Payment missing', userId: 'user-1' });
      const tx = {
         ticketMessage: {
            create: jest.fn().mockResolvedValue({ id: 'm9', authorType: 'agent', body: 'Looking into it', createdAt: NOW }),
         },
         ticket: { update: jest.fn() },
         ticketStatusChange: { create: jest.fn() },
      };
      db.$transaction.mockImplementation(async (callback: (t: typeof tx) => unknown) => callback(tx));
      db.ticketMessage.updateMany.mockResolvedValue({ count: 1 });
      db.ticketMessage.findUnique.mockResolvedValue({ ticketId: 't1' });
      db.user.findUnique.mockResolvedValue({ email: 'owner@example.test' });

      const result = await replyAsAgent('t1', 'admin-1', { body: 'Looking into it' }, NOW);

      expect(result.notification).toBe('sent');
      expect(tx.ticketStatusChange.create).toHaveBeenCalledWith({
         data: expect.objectContaining({ fromStatus: 'open', toStatus: 'waiting', actorType: 'agent' }),
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0].to).toBe('owner@example.test');
      expect(mockSend.mock.calls[0][0].text).toContain('https://app.test/support/tickets/t1');
   });
});

describe('notifyUserOfAgentReply', () => {
   it('sends at most one email per agent message', async () => {
      db.ticketMessage.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
      db.ticketMessage.findUnique.mockResolvedValue({ ticketId: 't1' });
      db.ticket.findUnique.mockResolvedValue({ id: 't1', subject: 'Payment missing', userId: 'user-1' });
      db.user.findUnique.mockResolvedValue({ email: 'owner@example.test' });

      await expect(notifyUserOfAgentReply('m9', NOW)).resolves.toBe('sent');
      await expect(notifyUserOfAgentReply('m9', NOW)).resolves.toBe('already_notified');

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(db.ticketMessage.updateMany).toHaveBeenCalledWith({
         where: { id: 'm9', authorType: 'agent', notifiedAt: null },
         data: { notifiedAt: NOW },
      });
   });
});
