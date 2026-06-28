import request from 'supertest';
import { app } from '../../app';

describe('GET /api/v1/wallets/:address/activity - Malformed Stellar Address', () => {
   it('should return 400 for address with wrong prefix', async () => {
      const response = await request(app)
         .get(
            '/api/v1/wallets/XBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/activity'
         )
         .expect(400);

      expect(response.body.error).toBeDefined();
      expect(response.body.details).toBeDefined();
      expect(
         response.body.details.some((d: any) => d.field === 'address')
      ).toBeTruthy();
   });

   it('should return 400 for too-short address', async () => {
      const response = await request(app)
         .get('/api/v1/wallets/GASHORT/activity')
         .expect(400);

      expect(response.body.error).toBeDefined();
      expect(response.body.details).toBeDefined();
      expect(
         response.body.details.some((d: any) => d.field === 'address')
      ).toBeTruthy();
   });

   it('should return 400 for address with invalid characters', async () => {
      const response = await request(app)
         .get(
            '/api/v1/wallets/GA!!!INVALID!!!CHARACTERS!!!HERE!!!AAAAAAAAAAAAAAAAA/activity'
         )
         .expect(400);

      expect(response.body.error).toBeDefined();
      expect(response.body.details).toBeDefined();
      expect(
         response.body.details.some((d: any) => d.field === 'address')
      ).toBeTruthy();
   });

   it('should return 400 for completely invalid address format', async () => {
      const response = await request(app)
         .get('/api/v1/wallets/not-a-stellar-address/activity')
         .expect(400);

      expect(response.body.error).toBeDefined();
      expect(response.body.details).toBeDefined();
      expect(
         response.body.details.some((d: any) => d.field === 'address')
      ).toBeTruthy();
   });

   it('should not return 400 for valid Stellar address format', async () => {
      // Using a properly formatted Stellar address (may return 200 with empty data or 404)
      const response = await request(app)
         .get(
            '/api/v1/wallets/GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF/activity'
         )
         .expect(res => {
            // Should be 200 (valid request) or potentially 404 (wallet not found)
            // But NOT 400 (validation error)
            expect([200, 404]).toContain(res.status);
         });

      expect(response.status).not.toBe(400);
   });
});
