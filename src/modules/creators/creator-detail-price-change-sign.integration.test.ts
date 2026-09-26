import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

const USER_ID_UP = 'creator-price-change-sign-up-user';
const HANDLE_UP = 'creator-price-change-sign-up';

const USER_ID_DOWN = 'creator-price-change-sign-down-user';
const HANDLE_DOWN = 'creator-price-change-sign-down';

describe('creator detail endpoint — priceChange24h sign (#576)', () => {
   let creatorIdUp: string;
   let creatorIdDown: string;

   beforeAll(async () => {
      await prisma.user.upsert({
         where: { id: USER_ID_UP },
         create: {
            id: USER_ID_UP,
            email: 'creator-price-change-sign-up@example.test',
            passwordHash: 'dummy-hash',
            firstName: 'Price',
            lastName: 'Up',
         },
         update: {},
      });
      await prisma.user.upsert({
         where: { id: USER_ID_DOWN },
         create: {
            id: USER_ID_DOWN,
            email: 'creator-price-change-sign-down@example.test',
            passwordHash: 'dummy-hash',
            firstName: 'Price',
            lastName: 'Down',
         },
         update: {},
      });

      const creatorUp = await prisma.creatorProfile.upsert({
         where: { handle: HANDLE_UP },
         create: {
            userId: USER_ID_UP,
            handle: HANDLE_UP,
            displayName: 'Price Change Sign Up Creator',
         },
         update: {},
      });
      creatorIdUp = creatorUp.id;

      const creatorDown = await prisma.creatorProfile.upsert({
         where: { handle: HANDLE_DOWN },
         create: {
            userId: USER_ID_DOWN,
            handle: HANDLE_DOWN,
            displayName: 'Price Change Sign Down Creator',
         },
         update: {},
      });
      creatorIdDown = creatorDown.id;

      // Current price higher than the 24h-ago snapshot -> positive change
      await prisma.creatorPriceSnapshot.create({
         data: {
            creatorId: creatorIdUp,
            currentPrice: BigInt(1_500_000),
            price24hAgo: BigInt(1_000_000),
            lastTradeAt: new Date(),
         },
      });

      // Current price lower than the 24h-ago snapshot -> negative change
      await prisma.creatorPriceSnapshot.create({
         data: {
            creatorId: creatorIdDown,
            currentPrice: BigInt(800_000),
            price24hAgo: BigInt(1_000_000),
            lastTradeAt: new Date(),
         },
      });
   });

   afterAll(async () => {
      await prisma.creatorPriceSnapshot.deleteMany({
         where: { creatorId: { in: [creatorIdUp, creatorIdDown] } },
      });
      await prisma.creatorProfile.deleteMany({
         where: { handle: { in: [HANDLE_UP, HANDLE_DOWN] } },
      });
      await prisma.user.deleteMany({
         where: { id: { in: [USER_ID_UP, USER_ID_DOWN] } },
      });
      await prisma.$disconnect();
   });

   it('returns a positive priceChange24h when the price increased over 24h', async () => {
      const res = await supertest(app).get(
         `/api/v1/creators/${creatorIdUp}/profile`
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('priceChange24h');
      expect(res.body.data.priceChange24h).not.toBeNull();
      expect(res.body.data.priceChange24h).toBeGreaterThan(0);
   });

   it('returns a negative priceChange24h when the price decreased over 24h', async () => {
      const res = await supertest(app).get(
         `/api/v1/creators/${creatorIdDown}/profile`
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('priceChange24h');
      expect(res.body.data.priceChange24h).not.toBeNull();
      expect(res.body.data.priceChange24h).toBeLessThan(0);
   });
});
