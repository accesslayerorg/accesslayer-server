import request from 'supertest';
import express from 'express';
import dividendRouter from './dividend.routes';
import holdersRouter from './holders.routes';
import { prisma } from '../../utils/prisma.utils';
import { errorHandler } from '../../middlewares/error.middleware';
import * as redisUtils from '../../utils/redis.utils';
import {
   processDividendEvents,
   processDividendContractLogs,
   parseDividendContractLog,
} from '../indexer/dividend-indexer.service';
import {
   emitContractTxConfirmed,
} from '../contracts/contract-events.utils';
import {
   TransactionBuilder,
   Networks,
   Keypair,
} from '@stellar/stellar-base';

const app = express();
app.use(express.json());
app.use('/keys', dividendRouter);
app.use('/holders', holdersRouter);
app.use(errorHandler);

const TEST_KEY_ID = 'creator-pool-test-key-1';
const TEST_WALLET_1 = Keypair.random().publicKey();
const TEST_WALLET_2 = Keypair.random().publicKey();

describe('Dividend Pool Distribution API Endpoints (#965)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   describe('GET /keys/:keyId/dividends — distribution history with pagination & 60s TTL cache', () => {
      it('AC1: returns paginated distribution history with correct amounts', async () => {
         jest.spyOn(prisma.creatorProfile, 'findUnique').mockResolvedValue({
            id: TEST_KEY_ID,
         } as any);

         const mockDistributions = [
            {
               id: 'dist-1',
               creatorId: TEST_KEY_ID,
               distributionDate: new Date('2026-09-01T12:00:00Z'),
               totalAmountXlm: 500,
               holderCount: 5,
               perKeyAmountXlm: 100,
               ledger: 100,
               txHash: 'hash-1',
            },
            {
               id: 'dist-2',
               creatorId: TEST_KEY_ID,
               distributionDate: new Date('2026-08-01T12:00:00Z'),
               totalAmountXlm: 250,
               holderCount: 5,
               perKeyAmountXlm: 50,
               ledger: 90,
               txHash: 'hash-2',
            },
         ];

         jest.spyOn(prisma.dividendDistribution, 'findMany').mockResolvedValue(
            mockDistributions as any
         );

         const res = await request(app).get(`/keys/${TEST_KEY_ID}/dividends?limit=10`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.entries).toHaveLength(2);
         expect(res.body.data.entries[0]).toEqual({
            distributionId: 'dist-1',
            totalAmount: 500,
            holderCount: 5,
            perKeyAmount: 100,
            distributedAt: new Date('2026-09-01T12:00:00Z').toISOString(),
         });
         expect(res.body.data.pagination).toEqual({
            limit: 10,
            hasMore: false,
            nextCursor: undefined,
         });
      });

      it('AC1: serves from 60s TTL cache on subsequent requests', async () => {
         jest.spyOn(prisma.creatorProfile, 'findUnique').mockResolvedValue({
            id: TEST_KEY_ID,
         } as any);

         const cachedData = {
            distributions: [
               {
                  id: 'dist-cached',
                  creatorId: TEST_KEY_ID,
                  distributionDate: '2026-09-01T12:00:00.000Z',
                  totalAmount: 300,
                  holderCount: 3,
                  perKeyAmount: 100,
                  distributedAt: '2026-09-01T12:00:00.000Z',
               },
            ],
            hasMore: false,
         };

         jest.spyOn(redisUtils, 'cacheGetJson').mockResolvedValue(cachedData as any);
         const dbFindManySpy = jest.spyOn(prisma.dividendDistribution, 'findMany');

         const res = await request(app).get(`/keys/${TEST_KEY_ID}/dividends?limit=50`);

         expect(res.status).toBe(200);
         expect(res.body.data.entries[0].distributionId).toBe('dist-cached');
         expect(dbFindManySpy).not.toHaveBeenCalled();
      });

      it('AC1: writes to cache with 60s TTL on cache miss', async () => {
         jest.spyOn(prisma.creatorProfile, 'findUnique').mockResolvedValue({
            id: TEST_KEY_ID,
         } as any);

         jest.spyOn(redisUtils, 'cacheGetJson').mockResolvedValue(null);
         const cacheSetSpy = jest.spyOn(redisUtils, 'cacheSetJson').mockResolvedValue();

         jest.spyOn(prisma.dividendDistribution, 'findMany').mockResolvedValue([
            {
               id: 'dist-new',
               creatorId: TEST_KEY_ID,
               distributionDate: new Date(),
               totalAmountXlm: 100,
               holderCount: 2,
               perKeyAmountXlm: 50,
               ledger: 10,
               txHash: 'hash-new',
            },
         ] as any);

         const res = await request(app).get(`/keys/${TEST_KEY_ID}/dividends?limit=50`);

         expect(res.status).toBe(200);
         expect(cacheSetSpy).toHaveBeenCalledWith(
            expect.stringContaining(`dividends:history:${TEST_KEY_ID}`),
            expect.any(Object),
            60
         );
      });

      it('returns 404 when key does not exist', async () => {
         jest.spyOn(prisma.creatorProfile, 'findUnique').mockResolvedValue(null);
         const res = await request(app).get('/keys/nonexistent-key/dividends');
         expect(res.status).toBe(404);
      });
   });

   describe('GET /holders/:wallet/dividends — aggregate pending and claimed across held keys', () => {
      it('AC2: returns aggregate pending and claimed totals per key and grand total', async () => {
         jest.spyOn(redisUtils, 'cacheGetJson').mockResolvedValue(null);

         const mockClaims = [
            {
               id: 'claim-1',
               distributionId: 'dist-1',
               recipientAddress: TEST_WALLET_1,
               amountXlm: 50.0,
               claimedAt: null, // pending
               distribution: { creatorId: 'key-alpha' },
            },
            {
               id: 'claim-2',
               distributionId: 'dist-2',
               recipientAddress: TEST_WALLET_1,
               amountXlm: 25.0,
               claimedAt: new Date('2026-09-02T10:00:00Z'), // claimed
               distribution: { creatorId: 'key-alpha' },
            },
            {
               id: 'claim-3',
               distributionId: 'dist-3',
               recipientAddress: TEST_WALLET_1,
               amountXlm: 80.0,
               claimedAt: null, // pending
               distribution: { creatorId: 'key-beta' },
            },
         ];

         const mockHoldings = [
            { creatorId: 'key-alpha' },
            { creatorId: 'key-beta' },
            { creatorId: 'key-gamma' }, // holding with no dividends yet
         ];

         jest.spyOn(prisma.dividendClaim, 'findMany').mockResolvedValue(mockClaims as any);
         jest.spyOn(prisma.keyOwnership, 'findMany').mockResolvedValue(mockHoldings as any);

         const res = await request(app).get(`/holders/${TEST_WALLET_1}/dividends`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);

         const data = res.body.data;
         expect(data.wallet).toBe(TEST_WALLET_1);
         expect(data.totalPending).toBe(130); // 50 + 80
         expect(data.totalClaimed).toBe(25);  // 25
         expect(data.total).toBe(155);         // 130 + 25

         expect(data.keys).toEqual([
            {
               keyId: 'key-alpha',
               pending: 50,
               claimed: 25,
               total: 75,
               pendingAmount: 50,
               claimedAmount: 25,
               totalAmount: 75,
            },
            {
               keyId: 'key-beta',
               pending: 80,
               claimed: 0,
               total: 80,
               pendingAmount: 80,
               claimedAmount: 0,
               totalAmount: 80,
            },
            {
               keyId: 'key-gamma',
               pending: 0,
               claimed: 0,
               total: 0,
               pendingAmount: 0,
               claimedAmount: 0,
               totalAmount: 0,
            },
         ]);
      });

      it('returns 400 for invalid Stellar wallet address', async () => {
         const res = await request(app).get('/holders/not-a-stellar-wallet/dividends');
         expect(res.status).toBe(400);
         expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });
   });

   describe('POST /keys/:keyId/dividends/claim — build and return unsigned claim transaction', () => {
      it('AC3: builds and returns a valid unsigned transaction deserializeable by Stellar SDK', async () => {
         jest.spyOn(prisma.creatorProfile, 'findUnique').mockResolvedValue({
            id: TEST_KEY_ID,
         } as any);

         jest.spyOn(prisma.dividendClaim, 'findMany').mockResolvedValue([
            { amountXlm: 45.5 },
         ] as any);

         const res = await request(app)
            .post(`/keys/${TEST_KEY_ID}/dividends/claim`)
            .send({ wallet: TEST_WALLET_1 });

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);

         const { transaction, networkPassphrase, keyId, claimantWallet, pendingAmount } =
            res.body.data;

         expect(transaction).toBeDefined();
         expect(typeof transaction).toBe('string');
         expect(keyId).toBe(TEST_KEY_ID);
         expect(claimantWallet).toBe(TEST_WALLET_1);
         expect(pendingAmount).toBe(45.5);

         // Validate that the returned string is a valid unsigned Stellar transaction
         const parsedTx = TransactionBuilder.fromXDR(
            transaction,
            networkPassphrase || Networks.TESTNET
         );
         expect(parsedTx).toBeDefined();
         expect(parsedTx.operations.length).toBe(1);
         expect(parsedTx.signatures.length).toBe(0); // unsigned!
      });

      it('returns 404 when key does not exist', async () => {
         jest.spyOn(prisma.creatorProfile, 'findUnique').mockResolvedValue(null);

         const res = await request(app)
            .post('/keys/unknown-key/dividends/claim')
            .send({ wallet: TEST_WALLET_1 });

         expect(res.status).toBe(404);
      });

      it('returns 400 when wallet is missing', async () => {
         jest.spyOn(prisma.creatorProfile, 'findUnique').mockResolvedValue({
            id: TEST_KEY_ID,
         } as any);

         const res = await request(app)
            .post(`/keys/${TEST_KEY_ID}/dividends/claim`)
            .send({});

         expect(res.status).toBe(400);
      });
   });

   describe('Indexing dividend data from contract logs & events', () => {
      it('AC4: indexes DIVIDEND_DISTRIBUTED events and creates claims for holders', async () => {
         const createDistSpy = jest
            .spyOn(prisma.dividendDistribution, 'create')
            .mockResolvedValue({
               id: 'dist-indexer-1',
               creatorId: TEST_KEY_ID,
            } as any);

         jest.spyOn(prisma.keyOwnership, 'findMany').mockResolvedValue([
            { id: 'h1', ownerAddress: TEST_WALLET_1, balance: 10 },
            { id: 'h2', ownerAddress: TEST_WALLET_2, balance: 10 },
         ] as any);

         const createClaimsSpy = jest
            .spyOn(prisma.dividendClaim, 'createMany')
            .mockResolvedValue({ count: 2 } as any);

         const activitySpy = jest
            .spyOn(prisma.activity, 'create')
            .mockResolvedValue({} as any);

         await processDividendEvents([
            {
               eventType: 'DIVIDEND_DISTRIBUTED',
               creatorId: TEST_KEY_ID,
               totalAmountXlm: '200',
               holdersCount: 2,
               distributorAddress: 'GDIST000000000000000000000000000000000001',
               distributedAt: new Date().toISOString(),
               ledger: 500,
               txHash: 'tx-dist-1',
               eventIndex: 0,
            },
         ]);

         expect(createDistSpy).toHaveBeenCalled();
         expect(createClaimsSpy).toHaveBeenCalledWith({
            data: [
               { distributionId: 'dist-indexer-1', recipientAddress: TEST_WALLET_1, amountXlm: 1000 },
               { distributionId: 'dist-indexer-1', recipientAddress: TEST_WALLET_2, amountXlm: 1000 },
            ],
            skipDuplicates: true,
         });
         expect(activitySpy).toHaveBeenCalled();
      });

      it('AC4: indexes DIVIDEND_CLAIMED events and updates claimedAt', async () => {
         const updateManySpy = jest
            .spyOn(prisma.dividendClaim, 'updateMany')
            .mockResolvedValue({ count: 1 } as any);

         const activitySpy = jest
            .spyOn(prisma.activity, 'create')
            .mockResolvedValue({} as any);

         const cacheInvalidateSpy = jest
            .spyOn(redisUtils, 'cacheInvalidate')
            .mockResolvedValue();

         await processDividendEvents([
            {
               eventType: 'DIVIDEND_CLAIMED',
               creatorId: TEST_KEY_ID,
               claimantAddress: TEST_WALLET_1,
               amountXlm: '50.0',
               distributionId: 'dist-1',
               claimedAt: '2026-09-28T12:00:00Z',
               ledger: 501,
               txHash: 'tx-claim-1',
               eventIndex: 0,
            },
         ]);

         expect(updateManySpy).toHaveBeenCalledWith({
            where: {
               distributionId: 'dist-1',
               recipientAddress: TEST_WALLET_1,
            },
            data: {
               claimedAt: new Date('2026-09-28T12:00:00Z'),
            },
         });

         expect(activitySpy).toHaveBeenCalled();
         expect(cacheInvalidateSpy).toHaveBeenCalled();
      });

      it('AC4: parses and indexes raw contract logs', async () => {
         const log = {
            contractId: TEST_KEY_ID,
            topics: ['dividend_claimed', TEST_KEY_ID, TEST_WALLET_1, '35.5'],
            ledger: 600,
            txHash: 'tx-raw-log-1',
            timestamp: '2026-09-28T12:30:00Z',
            eventIndex: 0,
         };

         const parsed = parseDividendContractLog(log);
         expect(parsed).toEqual({
            eventType: 'DIVIDEND_CLAIMED',
            creatorId: TEST_KEY_ID,
            claimantAddress: TEST_WALLET_1,
            amountXlm: '35.5',
            distributionId: undefined,
            claimedAt: '2026-09-28T12:30:00.000Z',
            ledger: 600,
            txHash: 'tx-raw-log-1',
            eventIndex: 0,
         });

         const updateSpy = jest
            .spyOn(prisma.dividendClaim, 'updateMany')
            .mockResolvedValue({ count: 1 } as any);
         jest.spyOn(prisma.activity, 'create').mockResolvedValue({} as any);

         await processDividendContractLogs([log]);
         expect(updateSpy).toHaveBeenCalled();
      });
   });

   describe('Cache invalidation after claim confirmation', () => {
      it('AC5: invalidates dividend cache when a claim contract transaction confirms', async () => {
         const cacheInvalidateSpy = jest
            .spyOn(redisUtils, 'cacheInvalidate')
            .mockResolvedValue();

         emitContractTxConfirmed({
            operation: 'claim',
            submitterWallet: TEST_WALLET_1,
            txHash: 'tx-claim-confirmed-123',
            ledger: 750,
            attempts: 1,
         });

         expect(cacheInvalidateSpy).toHaveBeenCalledWith(
            'dividends:history:*',
            'dividends:holder:*',
            `dividends:holder:${TEST_WALLET_1}:*`,
            `dividends:holder:${TEST_WALLET_1}*`
         );
      });
   });
});
