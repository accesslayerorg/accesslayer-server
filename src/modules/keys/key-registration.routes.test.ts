// src/modules/keys/key-registration.routes.test.ts
import express, { Express } from 'express';
import supertest from 'supertest';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      registeredKey: {
         findUnique: jest.fn(),
         create: jest.fn(),
      },
      creatorProfile: {
         findFirst: jest.fn(),
      },
   },
}));

jest.mock('../../utils/soroban-rpc.utils', () => ({
   getLedgerEntries: jest.fn(),
}));

jest.mock('../../utils/audit.utils', () => ({
   emitAuditEvent: jest.fn(),
}));

jest.mock('../../config', () => ({
   envConfig: {
      INTERNAL_SERVICE_KEY: 'test-internal-key-secret',
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { getLedgerEntries } from '../../utils/soroban-rpc.utils';
import keysRouter from './keys.routes';

const mockRegisteredKeyFindUnique = prisma.registeredKey.findUnique as jest.Mock;
const mockRegisteredKeyCreate = prisma.registeredKey.create as jest.Mock;
const mockGetLedgerEntries = getLedgerEntries as jest.Mock;

const VALID_CONTRACT = 'CCW67TSB3SSS33333333333333333333333333333333333333333333';
const VALID_STELLAR_WALLET = 'GA5XIGA5C7GTGTW7ZKJ4YV6OEILUY2Q7YIHZQNNDJUWAVES4O7D5SUK7';
const API_KEY = 'test-internal-key-secret';

describe('POST /keys/register Route Integration Tests', () => {
   let app: Express;

   beforeAll(() => {
      app = express();
      app.use(express.json());
      app.use('/keys', keysRouter);
   });

   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('Internal API Key Authentication', () => {
      it('returns 401 UNAUTHORIZED when no API key header is sent', async () => {
         const res = await supertest(app)
            .post('/keys/register')
            .send({ keyAddress: VALID_CONTRACT, creatorWallet: VALID_STELLAR_WALLET });

         expect(res.status).toBe(401);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('UNAUTHORIZED');
      });

      it('returns 401 UNAUTHORIZED when invalid API key header is sent', async () => {
         const res = await supertest(app)
            .post('/keys/register')
            .set('x-api-key', 'wrong-key')
            .send({ keyAddress: VALID_CONTRACT, creatorWallet: VALID_STELLAR_WALLET });

         expect(res.status).toBe(401);
         expect(res.body.success).toBe(false);
      });
   });

   describe('Registration & Validation', () => {
      it('returns 400 VALIDATION_ERROR when key address is missing or invalid on-chain', async () => {
         const res = await supertest(app)
            .post('/keys/register')
            .set('x-api-key', API_KEY)
            .send({ keyAddress: 'invalid-address', creatorWallet: VALID_STELLAR_WALLET });

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
      });

      it('returns 409 CONFLICT when contract address is already registered', async () => {
         mockGetLedgerEntries.mockResolvedValue({
            entries: [{ key: 'k', xdr: 'x', lastModifiedLedgerSeq: 1 }],
            latestLedger: 100,
         });
         mockRegisteredKeyFindUnique.mockResolvedValue({
            id: 'rk_1',
            keyAddress: VALID_CONTRACT,
         });

         const res = await supertest(app)
            .post('/keys/register')
            .set('x-api-key', API_KEY)
            .send({ keyAddress: VALID_CONTRACT, creatorWallet: VALID_STELLAR_WALLET });

         expect(res.status).toBe(409);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('CONFLICT');
         expect(res.body.error.message).toContain('already registered');
      });

      it('returns 201 Created and registers key contract when valid', async () => {
         mockGetLedgerEntries.mockResolvedValue({
            entries: [{ key: 'k', xdr: 'x', lastModifiedLedgerSeq: 1 }],
            latestLedger: 100,
         });
         mockRegisteredKeyFindUnique.mockResolvedValue(null);
         mockRegisteredKeyCreate.mockResolvedValue({
            id: 'rk_100',
            keyAddress: VALID_CONTRACT,
            creatorWallet: VALID_STELLAR_WALLET,
            handle: 'creator1',
            displayName: 'Creator One',
            metadata: { feeTier: 'tier1' },
            status: 'ACTIVE',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
         });

         const res = await supertest(app)
            .post('/keys/register')
            .set('x-api-key', API_KEY)
            .send({
               keyAddress: VALID_CONTRACT,
               creatorWallet: VALID_STELLAR_WALLET,
               handle: 'creator1',
               displayName: 'Creator One',
               metadata: { feeTier: 'tier1' },
            });

         expect(res.status).toBe(201);
         expect(res.body.success).toBe(true);
         expect(res.body.data.keyAddress).toBe(VALID_CONTRACT);
         expect(res.body.message).toBe('Key contract registered successfully');
      });
   });
});
