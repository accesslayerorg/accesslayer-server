jest.mock('../../config', () => ({
   envConfig: {
      JWT_SECRET: 'x'.repeat(48),
      BACKEND_URL: 'https://api.test',
      FRONTEND_URL: 'https://app.test',
   },
}));
jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() },
}));
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      stellarWallet: { findUnique: jest.fn() },
      ticketAttachment: { findUnique: jest.fn(), updateMany: jest.fn() },
   },
}));

import express from 'express';
import request from 'supertest';
import { prisma } from '../../utils/prisma.utils';
import { signLink } from '../../utils/signed-url.utils';
import { supportAttachmentUploadRouter, supportRouter } from './support.routes';
import { ATTACHMENT_UPLOAD_PURPOSE } from './support.constants';

const db = prisma as unknown as {
   stellarWallet: { findUnique: jest.Mock };
   ticketAttachment: { findUnique: jest.Mock; updateMany: jest.Mock };
};

const app = express();
app.use('/api/v1/support', supportAttachmentUploadRouter);
app.use('/api/v1/support', express.json(), supportRouter);
app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
   res.status(500).json({ success: false });
});

const PNG = Buffer.concat([
   Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
   Buffer.from('image-body'),
]);
const expiresMs = Date.now() + 10 * 60 * 1000;

beforeEach(() => {
   jest.clearAllMocks();
});

describe('support user routes', () => {
   it('requires a wallet token to create a ticket', async () => {
      const res = await request(app).post('/api/v1/support/tickets').send({});
      expect(res.status).toBe(401);
   });
});

describe('PUT /support/attachments/:id/upload', () => {
   it('rejects a request whose signature does not verify', async () => {
      const res = await request(app)
         .put(`/api/v1/support/attachments/a1/upload?expires=${expiresMs}&sig=forged`)
         .set('Content-Type', 'image/png')
         .send(PNG);
      expect(res.status).toBe(403);
      expect(db.ticketAttachment.findUnique).not.toHaveBeenCalled();
   });

   it('returns 404 when the attachment does not exist', async () => {
      db.ticketAttachment.findUnique.mockResolvedValue(null);
      const sig = signLink(ATTACHMENT_UPLOAD_PURPOSE, 'a1', expiresMs);
      const res = await request(app)
         .put(`/api/v1/support/attachments/a1/upload?expires=${expiresMs}&sig=${sig}`)
         .set('Content-Type', 'image/png')
         .send(PNG);
      expect(res.status).toBe(404);
   });

   it('stores raw bytes sent with a JSON-looking content type', async () => {
      const sig = signLink(ATTACHMENT_UPLOAD_PURPOSE, 'a1', expiresMs);
      db.ticketAttachment.findUnique
         .mockResolvedValueOnce({ id: 'a1', status: 'pending', contentType: 'image/png', sizeBytes: PNG.length })
         .mockResolvedValueOnce({
            id: 'a1',
            fileName: 'shot.png',
            contentType: 'image/png',
            sizeBytes: PNG.length,
            status: 'uploaded',
            uploadedAt: new Date(),
         });
      db.ticketAttachment.updateMany.mockResolvedValue({ count: 1 });

      const res = await request(app)
         .put(`/api/v1/support/attachments/a1/upload?expires=${expiresMs}&sig=${sig}`)
         .set('Content-Type', 'image/png')
         .send(PNG);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('uploaded');
      const written = db.ticketAttachment.updateMany.mock.calls[0][0].data.content as Buffer;
      expect(Buffer.compare(written, PNG)).toBe(0);
   });

   it('refuses an executable with 422 before it is written', async () => {
      const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]);
      const sig = signLink(ATTACHMENT_UPLOAD_PURPOSE, 'a1', expiresMs);
      db.ticketAttachment.findUnique.mockResolvedValueOnce({
         id: 'a1',
         status: 'pending',
         contentType: 'image/png',
         sizeBytes: exe.length,
      });

      const res = await request(app)
         .put(`/api/v1/support/attachments/a1/upload?expires=${expiresMs}&sig=${sig}`)
         .set('Content-Type', 'image/png')
         .send(exe);

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('UNPROCESSABLE_ENTITY');
      expect(db.ticketAttachment.updateMany).not.toHaveBeenCalled();
   });
});
