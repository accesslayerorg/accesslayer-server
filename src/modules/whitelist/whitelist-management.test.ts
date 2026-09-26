import request from 'supertest';
import express from 'express';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn(), findUnique: jest.fn() },
      stellarWallet: { findUnique: jest.fn() },
      whitelist: {
         findMany: jest.fn(),
         createMany: jest.fn(),
         deleteMany: jest.fn(),
      },
   },
}));
import { errorHandler } from '../../middlewares/error.middleware';
import whitelistRouter from './whitelist.routes';
import { processWhitelistEvents } from '../indexer/whitelist-indexer.service';

const app = express();
app.use(express.json());
app.use('/keys', whitelistRouter);
app.use(errorHandler);

const CREATOR_WALLET = 'G' + 'A'.repeat(55);
const OTHER_WALLET = 'G' + 'B'.repeat(55);
const W1 = 'G' + 'C'.repeat(55);
const W2 = 'G' + 'D'.repeat(55);
const KEY_ID = 'key-1';

type Row = { address: string; creatorId: string; createdAt: Date };

describe('Whitelist management endpoints', () => {
   const creatorToken = signWalletAccessToken(CREATOR_WALLET);
   const otherToken = signWalletAccessToken(OTHER_WALLET);
   const creatorAuth = { Authorization: `Bearer ${creatorToken}` };
   const otherAuth = { Authorization: `Bearer ${otherToken}` };
   let rows: Row[];

   beforeEach(() => {
      rows = [];

      (prisma.creatorProfile.findFirst as any).mockImplementation(
         (args: any) =>
            Promise.resolve(
               args.where.OR.some(
                  (c: any) => c.id === KEY_ID || c.handle === KEY_ID
               )
                  ? { id: KEY_ID, userId: 'u1' }
                  : null
            )
      );
      (prisma.stellarWallet.findUnique as any).mockImplementation(
         (args: any) =>
            Promise.resolve(
               args.where.address === CREATOR_WALLET
                  ? { userId: 'u1' }
                  : args.where.address === OTHER_WALLET
                    ? { userId: 'u2' }
                    : null
            )
      );
      (prisma.whitelist.findMany as any).mockImplementation(
         (args: any) => {
            const inList: string[] | undefined = args.where.address?.in;
            return Promise.resolve(
               rows.filter(
                  r =>
                     r.creatorId === args.where.creatorId &&
                     (!inList || inList.includes(r.address))
               )
            );
         }
      );
      (prisma.whitelist.createMany as any).mockImplementation(
         (args: any) => {
            for (const d of args.data) {
               if (
                  !rows.some(
                     r => r.address === d.address && r.creatorId === d.creatorId
                  )
               ) {
                  rows.push({ ...d, createdAt: new Date() });
               }
            }
            return Promise.resolve({ count: args.data.length });
         }
      );
      (prisma.whitelist.deleteMany as any).mockImplementation(
         (args: any) => {
            const before = rows.length;
            const addrs: string[] = args.where.address.in ?? [
               args.where.address,
            ];
            rows = rows.filter(
               r =>
                  !(r.creatorId === args.where.creatorId && addrs.includes(r.address))
            );
            return Promise.resolve({ count: before - rows.length });
         }
      );
   });

   it('returns 401 without a token on all three endpoints', async () => {
      expect((await request(app).get(`/keys/${KEY_ID}/whitelist`)).status).toBe(401);
      expect(
         (
            await request(app)
               .post(`/keys/${KEY_ID}/whitelist`)
               .send({ wallets: [W1] })
         ).status
      ).toBe(401);
      expect(
         (await request(app).delete(`/keys/${KEY_ID}/whitelist/${W1}`)).status
      ).toBe(401);
   });

   it('returns 403 for a non-creator on all three endpoints', async () => {
      expect(
         (await request(app).get(`/keys/${KEY_ID}/whitelist`).set(otherAuth)).status
      ).toBe(403);
      expect(
         (
            await request(app)
               .post(`/keys/${KEY_ID}/whitelist`)
               .set(otherAuth)
               .send({ wallets: [W1] })
         ).status
      ).toBe(403);
      expect(
         (
            await request(app)
               .delete(`/keys/${KEY_ID}/whitelist/${W1}`)
               .set(otherAuth)
         ).status
      ).toBe(403);
   });

   it('bulk adds, lists, and removes wallets', async () => {
      const add = await request(app)
         .post(`/keys/${KEY_ID}/whitelist`)
         .set(creatorAuth)
         .send({ wallets: [W1, W2, W1] });
      expect(add.status).toBe(201);
      expect(add.body.data.added).toEqual([W1, W2]);

      const again = await request(app)
         .post(`/keys/${KEY_ID}/whitelist`)
         .set(creatorAuth)
         .send({ wallets: [W1] });
      expect(again.status).toBe(200);
      expect(again.body.data.alreadyWhitelisted).toEqual([W1]);

      const list = await request(app)
         .get(`/keys/${KEY_ID}/whitelist`)
         .set(creatorAuth);
      expect(list.status).toBe(200);
      expect(list.body.data.total).toBe(2);
      expect(list.body.data.wallets.map((w: any) => w.address).sort()).toEqual([
         W1,
         W2,
      ]);

      const del = await request(app)
         .delete(`/keys/${KEY_ID}/whitelist/${W1}`)
         .set(creatorAuth);
      expect(del.status).toBe(200);
      expect(rows.map(r => r.address)).toEqual([W2]);

      const missing = await request(app)
         .delete(`/keys/${KEY_ID}/whitelist/${W1}`)
         .set(creatorAuth);
      expect(missing.status).toBe(404);
   });

   it('validates wallet addresses and body shape', async () => {
      const post = (body: unknown) =>
         request(app).post(`/keys/${KEY_ID}/whitelist`).set(creatorAuth).send(body as object);
      expect((await post({ wallets: ['nope'] })).status).toBe(400);
      expect((await post({ wallets: [] })).status).toBe(400);
      expect(
         (
            await request(app)
               .delete(`/keys/${KEY_ID}/whitelist/not-a-wallet`)
               .set(creatorAuth)
         ).status
      ).toBe(400);
   });

   it('indexer events keep the database in step with chain state', async () => {
      (prisma.creatorProfile.findUnique as any).mockResolvedValue({
         id: KEY_ID,
      });
      const ev = (eventType: string, eventIndex: number, wallets: string[]) =>
         ({
            eventType,
            txHash: `tx${eventIndex}`,
            eventIndex,
            ledger: 10 + eventIndex,
            creatorId: KEY_ID,
            wallets,
         }) as any;

      await processWhitelistEvents([ev('WHITELIST_ADDED', 0, [W1, W2])]);
      expect(rows.map(r => r.address)).toEqual([W1, W2]);

      // Replay is idempotent
      await processWhitelistEvents([ev('WHITELIST_ADDED', 0, [W1, W2])]);
      expect(rows).toHaveLength(2);

      await processWhitelistEvents([ev('WHITELIST_REMOVED', 1, [W1])]);
      expect(rows.map(r => r.address)).toEqual([W2]);
   });
});
