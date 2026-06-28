import request from 'supertest';
import { app } from '../../app';

describe('GET /api/v1/creators/:id/holders - Invalid Creator ID', () => {
   it('should return 400 for non-numeric string', async () => {
      const response = await request(app)
         .get('/api/v1/creators/invalid-id/holders')
         .expect(400);

      expect(response.body.error).toBeDefined();
      expect(response.body.message).toMatch(/positive integer/i);
   });

   it('should return 400 for float', async () => {
      const response = await request(app)
         .get('/api/v1/creators/12.5/holders')
         .expect(400);

      expect(response.body.error).toBeDefined();
      expect(response.body.message).toMatch(/positive integer/i);
   });

   it('should return 400 for negative number', async () => {
      const response = await request(app)
         .get('/api/v1/creators/-5/holders')
         .expect(400);

      expect(response.body.error).toBeDefined();
      expect(response.body.message).toMatch(/positive integer/i);
   });

   it('should return 400 for zero', async () => {
      const response = await request(app)
         .get('/api/v1/creators/0/holders')
         .expect(400);

      expect(response.body.error).toBeDefined();
      expect(response.body.message).toMatch(/positive integer/i);
   });

   it('should not return 400 for valid positive integer', async () => {
      const response = await request(app)
         .get('/api/v1/creators/999999/holders')
         .expect(res => {
            // Should either return 404 (creator not found) or 200 (valid request)
            expect([200, 404]).toContain(res.status);
         });

      // If 400, the validation layer is incorrectly rejecting valid input
      expect(response.status).not.toBe(400);
   });
});
