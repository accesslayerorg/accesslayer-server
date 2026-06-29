import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

const USER_ID = 'creator-price-change-no-prior-user';
const HANDLE = 'creator-price-change-no-prior';

describe('creator detail endpoint — 24h price change without prior snapshot', () => {
   let creatorId: string;

   beforeAll(async () => {
      await prisma.user.upsert({
         where: { id: USER_ID },
         create: {
            id: USER_ID,
            email: 'creator-price-change-no-prior@example.test',
            passwordHash: 'dummy-hash',
            firstName: 'Price',
            lastName: 'Change',
         },
         update: {},
      });

      const creator = await prisma.creatorProfile.upsert({
         where: { userId: USER_ID },
         create: {
            userId: USER_ID,
            handle: HANDLE,
            displayName: 'Price Change No Prior Creator',
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

   it('returns zero priceChange24h when a current snapshot has no prior 24h baseline', async () => {
      await prisma.creatorPriceSnapshot.create({
         data: {
            creatorId,
            currentPrice: BigInt(1_500_000),
            price24hAgo: BigInt(0),
            lastTradeAt: new Date(),
         },
      });

      const res = await supertest(app).get(
         `/api/v1/creators/${creatorId}/profile`
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('priceChange24h');
      expect(res.body.data.priceChange24h).not.toBeNull();
      expect(res.body.data.priceChange24h).toBe(0);
   });
});
