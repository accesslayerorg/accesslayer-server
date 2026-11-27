import express from 'express';
import request from 'supertest';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { encryptNoteBody, decryptNoteBody } from './trade-notes.crypto';
import { OutcomeService } from './outcome.service';
import { tradeNotesRouter } from './trade-notes.routes';
import { upsertTradeNoteSchema } from './trade-notes.schemas';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      trade: {
         findFirst: jest.fn(),
      },
      activityLog: {
         findFirst: jest.fn(),
      },
      creatorPriceSnapshot: {
         findUnique: jest.fn(),
      },
      tradeNote: {
         upsert: jest.fn(),
         findMany: jest.fn(),
      },
   },
}));

jest.mock('../../middlewares/jwt-auth.middleware', () => ({
   requireJwtAuth: (req: any, _res: any, next: any) => {
      req.user = { wallet: req.headers['x-test-wallet'] || 'GWALLET_OWNER' };
      next();
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

const app = express();
app.use(express.json());
app.use('/v1/me', tradeNotesRouter);

describe('Trade Journal Storage API (#1315)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('Encryption & Privacy', () => {
      it('encrypts and decrypts note body at rest without exposing plaintext', () => {
         const secret = 'test-secret-key-32-chars-minimum!';
         const plaintext = 'Secret thesis: accumulating before creator milestone';
         const ciphertext = encryptNoteBody(plaintext, secret);

         expect(ciphertext).not.toContain(plaintext);
         expect(ciphertext.startsWith('v1:')).toBe(true);
         expect(decryptNoteBody(ciphertext, secret)).toBe(plaintext);
      });

      it('never logs the note body when upserting a note', async () => {
         const secretBody = 'PRIVATE_THESIS_DO_NOT_LOG_12345';
         (prisma.trade.findFirst as jest.Mock).mockResolvedValueOnce({
            creatorId: 'key-1',
            quantity: '2',
            price: '10',
         });
         (prisma.creatorPriceSnapshot.findUnique as jest.Mock).mockResolvedValueOnce({
            currentPrice: 120_000_000n,
         });
         (prisma.tradeNote.upsert as jest.Mock).mockResolvedValueOnce({
            id: 'note-1',
            wallet: 'GWALLET_OWNER',
            txHash: 'tx-abc',
            keyId: 'key-1',
            body: encryptNoteBody(secretBody),
            tags: ['momentum'],
            createdAt: new Date('2026-11-24T10:00:00Z'),
            updatedAt: new Date('2026-11-24T10:00:00Z'),
         });

         const res = await request(app)
            .put('/v1/me/trade-notes/tx-abc')
            .send({ body: secretBody, tags: ['momentum'] });

         expect(res.status).toBe(200);
         expect(res.body.data.body).toBe(secretBody);

         const logCalls = JSON.stringify((logger.info as jest.Mock).mock.calls);
         expect(logCalls).not.toContain(secretBody);
      });
   });

   describe('Validation limits', () => {
      it('rejects notes over 4,000 characters with 400', async () => {
         const tooLong = 'a'.repeat(4001);
         const res = await request(app)
            .put('/v1/me/trade-notes/tx-1')
            .send({ body: tooLong, tags: [] });

         expect(res.status).toBe(400);
         expect(upsertTradeNoteSchema.safeParse({ body: tooLong }).success).toBe(
            false
         );
      });

      it('rejects notes with more than 8 tags with 400', async () => {
         const res = await request(app)
            .put('/v1/me/trade-notes/tx-1')
            .send({
               body: 'Valid note',
               tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'],
            });

         expect(res.status).toBe(400);
      });
   });

   describe('Ownership verification', () => {
      it('returns 403 when the trade belongs to another wallet', async () => {
         (prisma.trade.findFirst as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'other-trade' });
         (prisma.activityLog.findFirst as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

         const res = await request(app)
            .put('/v1/me/trade-notes/tx-other')
            .set('x-test-wallet', 'GWALLET_ATTACKER')
            .send({ body: 'Trying to annotate someone else trade' });

         expect(res.status).toBe(403);
         expect(prisma.tradeNote.upsert).not.toHaveBeenCalled();
      });

      it('returns 404 when the trade does not exist', async () => {
         (prisma.trade.findFirst as jest.Mock).mockResolvedValue(null);
         (prisma.activityLog.findFirst as jest.Mock).mockResolvedValue(null);

         const res = await request(app)
            .put('/v1/me/trade-notes/tx-missing')
            .send({ body: 'Missing trade' });

         expect(res.status).toBe(404);
      });
   });

   describe('OutcomeService.compute', () => {
      it('matches manual calculation for buy trades', async () => {
         const outcome = await OutcomeService.compute({
            side: 'buy',
            keyId: 'key-1',
            quantity: 4,
            price: 10,
            fees: 1.5,
            latestPrice: 15,
         });

         // gross = 4 * (15 - 10) = 20; net = 20 - 1.5 = 18.5
         expect(outcome.grossPnl).toBe(20);
         expect(outcome.netPnl).toBe(18.5);
      });

      it('matches manual calculation for sell trades', async () => {
         const outcome = await OutcomeService.compute({
            side: 'sell',
            keyId: 'key-1',
            quantity: 3,
            price: 20,
            fees: 0.5,
            latestPrice: 14,
         });

         // gross = 3 * (20 - 14) = 18; net = 18 - 0.5 = 17.5
         expect(outcome.grossPnl).toBe(18);
         expect(outcome.netPnl).toBe(17.5);
      });
   });

   describe('GET /v1/me/trade-notes filtering and pagination', () => {
      it('filters by tag and keyId and returns nextCursor when more rows exist', async () => {
         const t1 = new Date('2026-11-24T12:00:00Z');
         const t2 = new Date('2026-11-24T11:00:00Z');

         (prisma.tradeNote.findMany as jest.Mock).mockResolvedValueOnce([
            {
               id: 'n1',
               wallet: 'GWALLET_OWNER',
               txHash: 'tx-1',
               keyId: 'key-9',
               body: encryptNoteBody('First note'),
               tags: ['breakout'],
               createdAt: t1,
               updatedAt: t1,
            },
            {
               id: 'n2',
               wallet: 'GWALLET_OWNER',
               txHash: 'tx-2',
               keyId: 'key-9',
               body: encryptNoteBody('Second note'),
               tags: ['breakout'],
               createdAt: t2,
               updatedAt: t2,
            },
         ]);
         (prisma.trade.findFirst as jest.Mock).mockResolvedValue(null);
         (prisma.activityLog.findFirst as jest.Mock).mockResolvedValue(null);

         const res = await request(app).get(
            '/v1/me/trade-notes?tag=breakout&keyId=key-9&limit=1'
         );

         expect(res.status).toBe(200);
         expect(res.body.data.items).toHaveLength(1);
         expect(res.body.data.items[0].body).toBe('First note');
         expect(res.body.data.hasMore).toBe(true);
         expect(typeof res.body.data.nextCursor).toBe('string');
         expect(prisma.tradeNote.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
               where: expect.objectContaining({
                  wallet: 'GWALLET_OWNER',
                  tags: { has: 'breakout' },
                  keyId: 'key-9',
               }),
               take: 2,
            })
         );
      });
   });
});
