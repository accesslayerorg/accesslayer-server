import request from 'supertest';
import { app } from '../../../app';
import { prisma } from '../../../utils/prisma.utils';

describe('POST /api/v1/alerts - Duplicate Alert', () => {
   const creatorId = '1';
   const walletAddress =
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
   const targetPrice = 100;
   const direction = 'above';
   const callbackUrl = 'https://example.com/webhook';

   afterEach(async () => {
      await prisma.priceAlert.deleteMany({
         where: { creatorId },
      });
   });

   it('should return 409 when registering duplicate alert with identical fields', async () => {
      const alertPayload = {
         creator_id: creatorId,
         wallet_address: walletAddress,
         target_price: targetPrice,
         direction,
         callback_url: callbackUrl,
      };

      // First registration should succeed
      await request(app).post('/api/v1/alerts').send(alertPayload).expect(201);

      // Second identical registration should return 409
      const response = await request(app)
         .post('/api/v1/alerts')
         .send(alertPayload)
         .expect(409);

      expect(response.body.error).toBeDefined();
      expect(response.body.message).toMatch(/already exists|duplicate/i);

      // Verify only one alert exists in database
      const count = await prisma.priceAlert.count({
         where: {
            creatorId,
            walletAddress,
            targetPrice,
            direction,
            isActive: true,
         },
      });
      expect(count).toBe(1);
   });

   it('should allow different direction with same target price', async () => {
      await request(app)
         .post('/api/v1/alerts')
         .send({
            creator_id: creatorId,
            wallet_address: walletAddress,
            target_price: targetPrice,
            direction: 'above',
            callback_url: callbackUrl,
         })
         .expect(201);

      // Different direction should succeed
      await request(app)
         .post('/api/v1/alerts')
         .send({
            creator_id: creatorId,
            wallet_address: walletAddress,
            target_price: targetPrice,
            direction: 'below',
            callback_url: callbackUrl,
         })
         .expect(201);

      const count = await prisma.priceAlert.count({
         where: { creatorId, walletAddress, isActive: true },
      });
      expect(count).toBe(2);
   });

   it('should allow same alert parameters for different wallets', async () => {
      const wallet2 =
         'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

      await request(app)
         .post('/api/v1/alerts')
         .send({
            creator_id: creatorId,
            wallet_address: walletAddress,
            target_price: targetPrice,
            direction,
            callback_url: callbackUrl,
         })
         .expect(201);

      await request(app)
         .post('/api/v1/alerts')
         .send({
            creator_id: creatorId,
            wallet_address: wallet2,
            target_price: targetPrice,
            direction,
            callback_url: callbackUrl,
         })
         .expect(201);

      const count = await prisma.priceAlert.count({
         where: { creatorId, isActive: true },
      });
      expect(count).toBe(2);
   });
});
