import request from 'supertest';
import { Keypair } from '@stellar/stellar-base';
import { buildAuthHeaders } from '../../utils/test/auth-request.utils';
import { sellGateway } from '../../modules/creator/sell.service';

// Mock in-memory state
interface KeyOwnershipRecord {
   id: string;
   ownerAddress: string;
   creatorId: string;
   balance: number;
   createdAt: Date;
   updatedAt: Date;
}

const keyOwnershipMap = new Map<string, KeyOwnershipRecord>();
let isTradingPaused = false;

const mockCreator = {
   id: '710',
   handle: 'creator-710',
   displayName: 'Creator 710',
   tradingPaused: false,
   user: {
      stellarWallet: {
         address: 'GCREATOR710000000000000000000000000000000000000000000000',
      },
   },
};

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: jest.fn(async (args?: any) => {
            const idOrHandle =
               args?.where?.OR?.[0]?.id ??
               args?.where?.id ??
               args?.where?.handle;
            if (idOrHandle === '710' || idOrHandle === 'creator-710') {
               return mockCreator;
            }
            return null;
         }),
         findUnique: jest.fn(async (args: any) => {
            if (args.where?.id === '710' || args.where?.id === 'creator-710') {
               return { ...mockCreator, tradingPaused: isTradingPaused };
            }
            return null;
         }),
         findMany: jest.fn(async () => [mockCreator]),
      },
      keyOwnership: {
         findUnique: jest.fn(async (args: any) => {
            const { ownerAddress, creatorId } =
               args.where.ownerAddress_creatorId;
            const key = `${ownerAddress}:${creatorId}`;
            const record = keyOwnershipMap.get(key);
            if (!record) return null;
            return {
               ...record,
               balance: record.balance.toString(),
            };
         }),
         findFirst: jest.fn(async (args: any) => {
            const { ownerAddress, creatorId } = args.where;
            const key = `${ownerAddress}:${creatorId}`;
            const record = keyOwnershipMap.get(key);
            if (!record) return null;
            return {
               ...record,
               balance: record.balance.toString(),
            };
         }),
         findMany: jest.fn(async (args: any) => {
            const { where, skip = 0, take = 50 } = args || {};
            let records = Array.from(keyOwnershipMap.values());

            if (where?.creatorId) {
               records = records.filter(r => r.creatorId === where.creatorId);
            }
            if (where?.ownerAddress) {
               records = records.filter(
                  r => r.ownerAddress === where.ownerAddress
               );
            }
            if (where?.balance?.gt !== undefined) {
               records = records.filter(r => r.balance > where.balance.gt);
            }

            return records.slice(skip, skip + take).map(r => ({
               ...r,
               balance: r.balance.toString(),
            }));
         }),
         count: jest.fn(async (args: any) => {
            const { where } = args || {};
            let records = Array.from(keyOwnershipMap.values());

            if (where?.creatorId) {
               records = records.filter(r => r.creatorId === where.creatorId);
            }
            if (where?.ownerAddress) {
               records = records.filter(
                  r => r.ownerAddress === where.ownerAddress
               );
            }
            if (where?.balance?.gt !== undefined) {
               records = records.filter(r => r.balance > where.balance.gt);
            }

            return records.length;
         }),
         aggregate: jest.fn(async (args: any) => {
            const { where } = args || {};
            let records = Array.from(keyOwnershipMap.values());

            if (where?.creatorId) {
               records = records.filter(r => r.creatorId === where.creatorId);
            }
            if (where?.balance?.gt !== undefined) {
               records = records.filter(r => r.balance > where.balance.gt);
            }

            const totalBalance = records.reduce((sum, r) => sum + r.balance, 0);
            return {
               _sum: {
                  balance: BigInt(totalBalance),
               },
            };
         }),
         upsert: jest.fn(async (args: any) => {
            const ownerAddress =
               args.create?.ownerAddress ||
               args.where.ownerAddress_creatorId.ownerAddress;
            const creatorId =
               args.create?.creatorId ||
               args.where.ownerAddress_creatorId.creatorId;
            const key = `${ownerAddress}:${creatorId}`;
            const existing = keyOwnershipMap.get(key);
            const currentBal = existing ? existing.balance : 0;
            const increment = args.update?.balance?.increment ?? 0;
            const newBal = currentBal + increment;

            const record: KeyOwnershipRecord = {
               id: existing?.id || `ko-${Date.now()}`,
               ownerAddress,
               creatorId,
               balance: newBal,
               createdAt: existing?.createdAt || new Date(),
               updatedAt: new Date(),
            };
            keyOwnershipMap.set(key, record);
            return {
               ...record,
               balance: newBal.toString(),
            };
         }),
      },
      activity: {
         create: jest.fn(async (args: any) => ({
            id: 'act-1',
            ...args.data,
         })),
         findMany: jest.fn(async () => []),
      },
      creatorPriceSnapshot: {
         findMany: jest.fn(async () => []),
      },
      $disconnect: jest.fn(),
   },
}));

import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

describe('Issue #710: Sell endpoint updating seller key balance integration test', () => {
   const sellerKeypair = Keypair.random();
   const sellerWallet = sellerKeypair.publicKey();
   const creatorId = '710';
   const storageKey = `${sellerWallet}:${creatorId}`;

   beforeEach(() => {
      jest.clearAllMocks();
      isTradingPaused = false;
      keyOwnershipMap.clear();

      // Step 1: Seed a wallet with a balance of 10 keys for the creator
      keyOwnershipMap.set(storageKey, {
         id: 'ko-seed-710',
         ownerAddress: sellerWallet,
         creatorId,
         balance: 10,
         createdAt: new Date('2026-01-01T00:00:00.000Z'),
         updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
   });

   it('executes a confirmed sell of 4 keys and updates the database record and balance endpoint to 6', async () => {
      const submitSellSpy = jest
         .spyOn(sellGateway, 'submitSell')
         .mockResolvedValue({
            transactionHash: 'tx-sell-confirmed-4-keys',
            confirmed: true,
         });

      const sellBody = { quantity: 4 };
      const authHeaders = buildAuthHeaders(sellBody, sellerKeypair);

      // Call sell endpoint to sell 4 keys
      const sellResponse = await request(app)
         .post(`/api/v1/creators/${creatorId}/sell`)
         .set(authHeaders)
         .send(sellBody);

      expect(sellResponse.status).toBe(200);
      expect(sellResponse.body.success).toBe(true);
      expect(sellResponse.body.data).toMatchObject({
         transactionHash: 'tx-sell-confirmed-4-keys',
         quantity: 4,
         balance: 6,
         confirmed: true,
      });
      expect(submitSellSpy).toHaveBeenCalledTimes(1);
      expect(submitSellSpy).toHaveBeenCalledWith({
         walletAddress: sellerWallet,
         creatorId,
         quantity: 4,
      });

      // Assert database record directly
      const dbRecord = await prisma.keyOwnership.findUnique({
         where: {
            ownerAddress_creatorId: {
               ownerAddress: sellerWallet,
               creatorId,
            },
         },
      });
      expect(dbRecord).not.toBeNull();
      expect(Number(dbRecord?.balance)).toBe(6);

      // Query balance endpoint for that wallet and creator, assert balance is 6
      const balanceEndpointResponse = await request(app)
         .get(`/api/v1/creators/${creatorId}/balance`)
         .query({ wallet: sellerWallet });

      expect(balanceEndpointResponse.status).toBe(200);
      expect(balanceEndpointResponse.body.success).toBe(true);
      expect(balanceEndpointResponse.body.data.balance).toBe(6);
      expect(balanceEndpointResponse.body.data.creatorId).toBe(creatorId);
      expect(balanceEndpointResponse.body.data.wallet).toBe(sellerWallet);

      // Query ownership endpoint as alternative balance view
      const ownershipResponse = await request(app)
         .get('/api/v1/ownership')
         .query({ ownerAddress: sellerWallet, creatorId });

      expect(ownershipResponse.status).toBe(200);
      expect(ownershipResponse.body.data.holdings).toHaveLength(1);
      expect(Number(ownershipResponse.body.data.holdings[0].balance)).toBe(6);

      // Assert wallet is still in the holders list
      const holdersResponse = await request(app).get(
         `/api/v1/creators/${creatorId}/holders`
      );
      expect(holdersResponse.status).toBe(200);
      const holderWallets = holdersResponse.body.data.items.map(
         (h: any) => h.wallet_address
      );
      expect(holderWallets).toContain(sellerWallet);
   });

   it('sells the remaining 6 keys, asserts balance is 0 in DB and balance endpoints, and asserts exclusion from holder list', async () => {
      // Step 2a: First sell 4 keys
      const submitSellSpy = jest
         .spyOn(sellGateway, 'submitSell')
         .mockResolvedValue({
            transactionHash: 'tx-sell-confirmed-part-1',
            confirmed: true,
         });

      const firstSellBody = { quantity: 4 };
      const firstSellResponse = await request(app)
         .post(`/api/v1/creators/${creatorId}/sell`)
         .set(buildAuthHeaders(firstSellBody, sellerKeypair))
         .send(firstSellBody);

      expect(firstSellResponse.status).toBe(200);
      expect(firstSellResponse.body.data.balance).toBe(6);

      // Step 2b: Sell remaining 6 keys
      submitSellSpy.mockResolvedValueOnce({
         transactionHash: 'tx-sell-confirmed-part-2',
         confirmed: true,
      });

      const secondSellBody = { quantity: 6 };
      const secondSellResponse = await request(app)
         .post(`/api/v1/creators/${creatorId}/sell`)
         .set(buildAuthHeaders(secondSellBody, sellerKeypair))
         .send(secondSellBody);

      expect(secondSellResponse.status).toBe(200);
      expect(secondSellResponse.body.data.balance).toBe(0);

      // Assert balance endpoint returns 0
      const balanceEndpointResponse = await request(app)
         .get(`/api/v1/creators/${creatorId}/balance`)
         .query({ wallet: sellerWallet });

      expect(balanceEndpointResponse.status).toBe(200);
      expect(balanceEndpointResponse.body.data.balance).toBe(0);

      // Assert database record directly has balance 0
      const dbRecord = await prisma.keyOwnership.findUnique({
         where: {
            ownerAddress_creatorId: {
               ownerAddress: sellerWallet,
               creatorId,
            },
         },
      });
      expect(Number(dbRecord?.balance)).toBe(0);

      // Query ownership endpoint to confirm 0 balance
      const ownershipResponse = await request(app)
         .get('/api/v1/ownership')
         .query({ ownerAddress: sellerWallet, creatorId });

      expect(ownershipResponse.status).toBe(200);
      expect(Number(ownershipResponse.body.data.holdings[0].balance)).toBe(0);

      // Assert the wallet is NO LONGER returned in the key holder list after selling all keys
      const holdersResponse = await request(app).get(
         `/api/v1/creators/${creatorId}/holders`
      );
      expect(holdersResponse.status).toBe(200);
      const holderWallets = holdersResponse.body.data.items.map(
         (h: any) => h.wallet_address
      );
      expect(holderWallets).not.toContain(sellerWallet);
      expect(holdersResponse.body.data.items).toHaveLength(0);
   });

   it('rejects selling more keys than current balance with 400 Bad Request', async () => {
      const sellBody = { quantity: 15 }; // current balance is 10
      const response = await request(app)
         .post(`/api/v1/creators/${creatorId}/sell`)
         .set(buildAuthHeaders(sellBody, sellerKeypair))
         .send(sellBody);

      expect(response.status).toBe(400);
      expect(['BAD_REQUEST', 'bad_request', 'insufficient_balance']).toContain(
         response.body.error.code
      );
      expect(response.body.error.message).toContain(
         'Insufficient key balance to sell'
      );

      // Assert balance remained unchanged at 10
      const dbRecord = await prisma.keyOwnership.findUnique({
         where: {
            ownerAddress_creatorId: {
               ownerAddress: sellerWallet,
               creatorId,
            },
         },
      });
      expect(Number(dbRecord?.balance)).toBe(10);
   });

   it('rejects selling with non-positive quantity with 400 or 422 validation error', async () => {
      const invalidBodies = [
         { quantity: 0 },
         { quantity: -3 },
         { quantity: 1.5 },
      ];

      for (const body of invalidBodies) {
         const response = await request(app)
            .post(`/api/v1/creators/${creatorId}/sell`)
            .set(buildAuthHeaders(body, sellerKeypair))
            .send(body);

         expect([400, 422]).toContain(response.status);
      }
   });

   it('returns 401 when stellar signature auth headers are missing', async () => {
      const sellBody = { quantity: 2 };
      const response = await request(app)
         .post(`/api/v1/creators/${creatorId}/sell`)
         .send(sellBody);

      expect(response.status).toBe(401);
   });

   it('returns 503 when trading is paused for the creator key', async () => {
      isTradingPaused = true;
      const sellBody = { quantity: 2 };
      const response = await request(app)
         .post(`/api/v1/creators/${creatorId}/sell`)
         .set(buildAuthHeaders(sellBody, sellerKeypair))
         .send(sellBody);

      expect(response.status).toBe(503);
   });

   it('supports selling and querying balance via /api/v1/keys/:keyId route aliases', async () => {
      jest.spyOn(sellGateway, 'submitSell').mockResolvedValue({
         transactionHash: 'tx-keys-route-sell',
         confirmed: true,
      });

      const sellBody = { quantity: 3 };
      const response = await request(app)
         .post(`/api/v1/keys/${creatorId}/sell`)
         .set(buildAuthHeaders(sellBody, sellerKeypair))
         .send(sellBody);

      expect(response.status).toBe(200);
      expect(response.body.data.balance).toBe(7);

      const balanceRes = await request(app)
         .get(`/api/v1/keys/${creatorId}/balance`)
         .query({ wallet: sellerWallet });

      expect(balanceRes.status).toBe(200);
      expect(balanceRes.body.data.balance).toBe(7);
   });
});
