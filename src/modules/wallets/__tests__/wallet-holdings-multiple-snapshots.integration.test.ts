import supertest from 'supertest';
import app from '../../../app';
import { prisma } from '../../../utils/prisma.utils';
import {
   seedCreatorMarketFixture,
   upsertCreatorPriceSnapshot,
} from '../../../utils/test/seeded-creator-fixtures.utils';

describe('GET /api/v1/wallets/:address/holdings - multiple price snapshot updates', () => {
   const WALLET_ADDRESS =
      'GCZURJAWEEAYDCIIUFMCGVDIKBASNKQQ7ZCX33BP2DZHFF52SG6BLW6J';
   const HOLDING_BALANCE = 5.0; // 5 keys held
   const SEED_PREFIX = 'wallet-multi-snap';

   let creatorId = '';
   let userId = '';

   beforeAll(async () => {
      // Clean up database tables to avoid tests leaking into each other
      await prisma.keyOwnership.deleteMany({
         where: { ownerAddress: WALLET_ADDRESS },
      });
      await prisma.creatorPriceSnapshot.deleteMany({
         where: { creatorId: { startsWith: SEED_PREFIX } },
      });
      await prisma.creatorProfile.deleteMany({
         where: { handle: { startsWith: `${SEED_PREFIX}-handle-` } },
      });
      await prisma.user.deleteMany({
         where: { id: { startsWith: `${SEED_PREFIX}-user-` } },
      });

      const seededCreator = await seedCreatorMarketFixture(prisma, 1, {
         prefix: SEED_PREFIX,
         displayName: 'Wallet Multi Snap Creator',
         walletAddress: WALLET_ADDRESS,
         balance: HOLDING_BALANCE,
      });

      creatorId = seededCreator.creatorId;
      userId = seededCreator.userId;
   });

   afterAll(async () => {
      // Clean up seeded database tables
      await prisma.keyOwnership.deleteMany({
         where: { ownerAddress: WALLET_ADDRESS },
      });
      if (creatorId) {
         await prisma.creatorPriceSnapshot.deleteMany({
            where: { creatorId },
         });
         await prisma.creatorProfile.deleteMany({ where: { id: creatorId } });
      }
      if (userId) {
         await prisma.user.deleteMany({ where: { id: userId } });
      }
      await prisma.$disconnect();
   });

   it('should reflect the correct total_value after multiple price snapshot updates', async () => {
      // First snapshot update
      await upsertCreatorPriceSnapshot(prisma, creatorId, 100n);

      let res = await supertest(app).get(
         `/api/v1/wallets/${WALLET_ADDRESS}/holdings`
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      let items = res.body.data.items;
      expect(items).toHaveLength(1);
      expect(items[0].current_price).toBe('100');
      expect(items[0].total_value).toBe('500');

      // Second snapshot update
      await upsertCreatorPriceSnapshot(prisma, creatorId, 250n);

      res = await supertest(app).get(
         `/api/v1/wallets/${WALLET_ADDRESS}/holdings`
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      items = res.body.data.items;
      expect(items).toHaveLength(1);
      expect(items[0].current_price).toBe('250');
      expect(items[0].total_value).toBe('1250');

      // Third snapshot update
      await upsertCreatorPriceSnapshot(prisma, creatorId, 300n);

      res = await supertest(app).get(
         `/api/v1/wallets/${WALLET_ADDRESS}/holdings`
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      items = res.body.data.items;
      expect(items).toHaveLength(1);
      expect(items[0].current_price).toBe('300');
      expect(items[0].total_value).toBe('1500');
   });
});
