import request from 'supertest';

const mockRegisteredKeysStore = new Map<string, any>();

const mockRegisteredKey = {
   findUnique: jest.fn(async ({ where }: { where: { keyAddress: string } }) => {
      return mockRegisteredKeysStore.get(where.keyAddress) || null;
   }),
   create: jest.fn(async ({ data }: { data: any }) => {
      const record = {
         id: `reg-${Date.now()}`,
         keyAddress: data.keyAddress,
         creatorWallet: data.creatorWallet,
         metadata: data.metadata || {},
         status: data.status || 'ACTIVE',
         createdAt: new Date(),
         updatedAt: new Date(),
      };
      mockRegisteredKeysStore.set(data.keyAddress, record);
      return record;
   }),
   deleteMany: jest.fn(async ({ where }: any) => {
      const keys = where?.keyAddress?.in || [];
      keys.forEach((k: string) => mockRegisteredKeysStore.delete(k));
      return { count: keys.length };
   }),
};

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: {
      registeredKey: mockRegisteredKey,
   },
}));

import app from '../../../app';
import { keyEvents } from '../key-events.service';
import { setMockOnChainValidation } from '../key-validation.service';

describe('POST /api/v1/keys/register Integration Tests', () => {
   const validApiKey = 'test_indexer_api_key_secret_12345';
   const testKeyAddress =
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
   const testCreatorWallet =
      'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
   const testMetadata = {
      royaltyBps: 500,
      initialSupply: 10,
      tier: 'gold',
   };

   beforeAll(() => {
      process.env.INDEXER_API_KEY = validApiKey;
   });

   afterAll(() => {
      delete process.env.INDEXER_API_KEY;
      setMockOnChainValidation(null);
   });

   beforeEach(() => {
      setMockOnChainValidation(null);
      mockRegisteredKeysStore.clear();
      jest.clearAllMocks();
   });

   describe('Authentication Guard', () => {
      it('returns 401 Unauthorized when x-api-key header is missing', async () => {
         const response = await request(app)
            .post('/api/v1/keys/register')
            .send({
               keyAddress: testKeyAddress,
               creatorWallet: testCreatorWallet,
               metadata: testMetadata,
            });

         expect(response.status).toBe(401);
         expect(response.body.success).toBe(false);
         expect(response.body.error.code).toBe('UNAUTHORIZED');
      });

      it('returns 403 Forbidden when x-api-key header is invalid', async () => {
         const response = await request(app)
            .post('/api/v1/keys/register')
            .set('x-api-key', 'wrong_invalid_key')
            .send({
               keyAddress: testKeyAddress,
               creatorWallet: testCreatorWallet,
               metadata: testMetadata,
            });

         expect(response.status).toBe(403);
         expect(response.body.success).toBe(false);
         expect(response.body.error.code).toBe('FORBIDDEN');
      });

      it('accepts authorization via Bearer token matching API key', async () => {
         const response = await request(app)
            .post('/api/v1/keys/register')
            .set('Authorization', `Bearer ${validApiKey}`)
            .send({
               keyAddress: testKeyAddress,
               creatorWallet: testCreatorWallet,
               metadata: testMetadata,
            });

         expect(response.status).toBe(201);
         expect(response.body.success).toBe(true);
      });
   });

   describe('Successful Key Registration', () => {
      it('registers key correctly with all metadata fields and returns 201 Created', async () => {
         let eventPayload: any = null;
         const eventHandler = (payload: any) => {
            eventPayload = payload;
         };
         keyEvents.on('key_registered', eventHandler);

         const response = await request(app)
            .post('/api/v1/keys/register')
            .set('x-api-key', validApiKey)
            .send({
               keyAddress: testKeyAddress,
               creatorWallet: testCreatorWallet,
               metadata: testMetadata,
            });

         keyEvents.off('key_registered', eventHandler);

         expect(response.status).toBe(201);
         expect(response.body.success).toBe(true);
         expect(response.body.data).toHaveProperty(
            'keyAddress',
            testKeyAddress
         );
         expect(response.body.data).toHaveProperty(
            'creatorWallet',
            testCreatorWallet
         );
         expect(response.body.data.metadata).toEqual(testMetadata);
         expect(response.body.data.status).toBe('ACTIVE');

         // Verify database model was called and state stored
         expect(mockRegisteredKey.create).toHaveBeenCalled();
         const dbRecord = mockRegisteredKeysStore.get(testKeyAddress);
         expect(dbRecord).toBeDefined();
         expect(dbRecord?.creatorWallet).toBe(testCreatorWallet);
         expect(dbRecord?.metadata).toEqual(testMetadata);

         // Verify key_registered event was emitted
         expect(eventPayload).not.toBeNull();
         expect(eventPayload?.keyAddress).toBe(testKeyAddress);
         expect(eventPayload?.creatorWallet).toBe(testCreatorWallet);
         expect(eventPayload?.metadata).toEqual(testMetadata);
      });

      it('supports contractAddress alias in request payload', async () => {
         const aliasAddress =
            'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';
         const response = await request(app)
            .post('/api/v1/keys/register')
            .set('x-api-key', validApiKey)
            .send({
               contractAddress: aliasAddress,
               creatorWallet: testCreatorWallet,
               metadata: { tier: 'silver' },
            });

         expect(response.status).toBe(201);
         expect(response.body.data.keyAddress).toBe(aliasAddress);
      });
   });

   describe('On-chain Validation', () => {
      it('rejects registration when contract address does not exist on-chain', async () => {
         setMockOnChainValidation(() => false);

         const response = await request(app)
            .post('/api/v1/keys/register')
            .set('x-api-key', validApiKey)
            .send({
               keyAddress: testKeyAddress,
               creatorWallet: testCreatorWallet,
               metadata: testMetadata,
            });

         expect(response.status).toBe(400);
         expect(response.body.success).toBe(false);
         expect(response.body.error.code).toBe('VALIDATION_ERROR');
         expect(response.body.error.message).toContain(
            'does not exist on-chain'
         );
      });
   });

   describe('Duplicate Handling', () => {
      it('returns 409 Conflict when attempting duplicate registration of same address', async () => {
         // First registration
         const res1 = await request(app)
            .post('/api/v1/keys/register')
            .set('x-api-key', validApiKey)
            .send({
               keyAddress: testKeyAddress,
               creatorWallet: testCreatorWallet,
               metadata: testMetadata,
            });
         expect(res1.status).toBe(201);

         // Second duplicate registration attempt
         const res2 = await request(app)
            .post('/api/v1/keys/register')
            .set('x-api-key', validApiKey)
            .send({
               keyAddress: testKeyAddress,
               creatorWallet: testCreatorWallet,
               metadata: testMetadata,
            });

         expect(res2.status).toBe(409);
         expect(res2.body.success).toBe(false);
         expect(res2.body.error.code).toBe('CONFLICT');
         expect(res2.body.error.message).toContain('already registered');
      });
   });
});
