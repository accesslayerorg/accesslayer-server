import supertest from 'supertest';
import app from '../../app';

describe('GET /api/v1/creators/:id/holders 404', () => {
  it('returns 404 with a clear error body for non-existent creator', async () => {
    // A random CUID that does not exist in the database
    const nonexistentId = 'nonexistent-creator-123';
    
    const res = await supertest(app).get(`/api/v1/creators/${nonexistentId}/holders`);
    
    expect(res.status).toBe(404);
    
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Creator not found',
      }
    });
  });
});
