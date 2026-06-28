// Integration test: creator route Method Not Allowed (405) validation
//
// Creator routes should return a 405 Method Not Allowed response when called with an
// unsupported HTTP method, and include an Allow header listing supported methods.

// Mock chalk first to avoid ESM issues
jest.mock('chalk', () => ({
  red: (text: string) => text,
  green: (text: string) => text,
  magenta: (text: string) => text,
  cyan: (text: string) => text,
}));

// Mock tspec to prevent hanging
jest.mock('tspec', () => ({
  TspecDocsMiddleware: jest.fn().mockResolvedValue([]),
}));

import supertest from 'supertest';
import app from '../../app';

// Mock all the things so we don't need a real database
jest.mock('../../utils/prisma.utils');
jest.mock('../../utils/logger.utils', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  }
}));
jest.mock('../../config', () => ({
  envConfig: { MODE: 'test', PORT: 3000, ENABLE_REQUEST_LOGGING: false },
  appConfig: { allowedOrigins: [] }
}));

describe('Creator routes — Method Not Allowed (405) validation', () => {
   describe('POST /api/v1/creators (unsupported method)', () => {
      it('returns 405 status code', async () => {
         const res = await supertest(app).post('/api/v1/creators');
         expect(res.status).toBe(405);
      });

      it('includes Allow header with GET', async () => {
         const res = await supertest(app).post('/api/v1/creators');
         expect(res.headers.allow).toBe('GET');
      });
   });

   describe('POST /api/v1/creators/test-id/stats (unsupported method)', () => {
      it('returns 405 status code', async () => {
         const res = await supertest(app).post('/api/v1/creators/test-id/stats');
         expect(res.status).toBe(405);
      });

      it('includes Allow header with GET', async () => {
         const res = await supertest(app).post('/api/v1/creators/test-id/stats');
         expect(res.headers.allow).toBe('GET');
      });
   });
});
