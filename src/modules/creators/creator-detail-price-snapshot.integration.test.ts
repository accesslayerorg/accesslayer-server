import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';
import { upsertPriceSnapshot } from '../indexer/price-snapshot.service';

const USER_ID = 'creator-price-snap-test-user';
const HANDLE = 'creator-price-snap-test';

describe('#504 creator detail endpoint — current_price from price snapshot', () => {
   let creatorId: string;

   beforeAll(async () => {
      await prisma.user.upsert({
         where: { id: USER_ID },
         create: {
            id: USER_ID,
            email: 'creator-price-snap-test@example.test',
            passwordHash: 'dummy-hash',
            firstName: 'Price',
            lastName: 'Snap',
         },
         update: {},
      });

      const creator = await prisma.creatorProfile.upsert({
         where: { userId: USER_ID },
         create: {
            userId: USER_ID,
            handle: HANDLE,
            displayName: 'Price Snap Creator',
         },
         update: {},
      });

      creatorId = creator.id;
   });

   afterAll(async () => {
      await prisma.creatorPriceSnapshot.deleteMany({ where: { creatorId } });
      await prisma.creatorProfile.deleteMany({ where: { handle: HANDLE } });
      await prisma.user.deleteMany({ where: { id: USER_ID } });
      await prisma.$disconnect();
   });

   it('creator detail returns null current_price before any snapshot exists', async () => {
      const res = await supertest(app).get(`/api/v1/creators/${creatorId}/profile`);
      expect(res.status).toBe(200);
      expect(res.body.data.currentPrice).toBeNull();
      expect(res.body.data.priceChange24h).toBeNull();
   });

   it('creator detail returns current_price matching seeded snapshot value', async () => {
      const seededPrice = BigInt(1_500_000);
      await upsertPriceSnapshot({
         creatorId,
         price: seededPrice,
         tradeAt: new Date(),
      });

      const res = await supertest(app).get(`/api/v1/creators/${creatorId}/profile`);
      expect(res.status).toBe(200);
      expect(res.body.data.currentPrice).toBe('1500000');
   });

   it('current_price updates after snapshot is refreshed', async () => {
      const initialPrice = BigInt(2_000_000);
      await upsertPriceSnapshot({
         creatorId,
         price: initialPrice,
         tradeAt: new Date(),
      });

      const beforeRes = await supertest(app).get(`/api/v1/creators/${creatorId}/profile`);
      expect(beforeRes.status).toBe(200);
      expect(beforeRes.body.data.currentPrice).toBe('2000000');

      const updatedPrice = BigInt(3_750_000);
      await upsertPriceSnapshot({
         creatorId,
         price: updatedPrice,
         tradeAt: new Date(),
      });

      const afterRes = await supertest(app).get(`/api/v1/creators/${creatorId}/profile`);
      expect(afterRes.status).toBe(200);
      expect(afterRes.body.data.currentPrice).toBe('3750000');
      expect(afterRes.body.data.currentPrice).not.toBe(beforeRes.body.data.currentPrice);
   });

   it('creator list includes current_price matching snapshot value', async () => {
      await upsertPriceSnapshot({
         creatorId,
         price: BigInt(500_000),
         tradeAt: new Date(),
      });

      const res = await supertest(app).get('/api/v1/creators');
      expect(res.status).toBe(200);

      const item = (res.body.data.items as any[]).find(
         (c: any) => c.id === creatorId
      );
      expect(item).toBeDefined();
      expect(item.currentPrice).toBe('500000');
   });

   it('creator list current_price updates after snapshot refresh', async () => {
      const beforeListRes = await supertest(app).get('/api/v1/creators');
      const beforeItem = (beforeListRes.body.data.items as any[]).find(
         (c: any) => c.id === creatorId
      );
      expect(beforeItem.currentPrice).toBe('500000');

      await upsertPriceSnapshot({
         creatorId,
         price: BigInt(750_000),
         tradeAt: new Date(),
      });

      const afterListRes = await supertest(app).get('/api/v1/creators');
      const afterItem = (afterListRes.body.data.items as any[]).find(
         (c: any) => c.id === creatorId
      );
      expect(afterItem.currentPrice).toBe('750000');
      expect(afterItem.currentPrice).not.toBe(beforeItem.currentPrice);
   });
});