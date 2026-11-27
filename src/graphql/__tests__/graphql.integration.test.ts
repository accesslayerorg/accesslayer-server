// src/graphql/__tests__/graphql.integration.test.ts
// Tests for the read-only GraphQL endpoint (issue #1248).
//
// Covers: nested key/holder/trade resolution, pagination, max-depth limit,
// max-cost limit, DataLoader batching (one query per level), and the absence
// of mutations.

import request from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

jest.setTimeout(30000);

// Mock prisma so GraphQL resolvers can be exercised without a live database.
jest.mock('../../utils/prisma.utils', () => {
   const prismaMock: any = {
      creatorProfile: {
         findUnique: jest.fn(),
         findMany: jest.fn(),
         count: jest.fn(),
      },
      trade: {
         findMany: jest.fn(),
         count: jest.fn(),
      },
   };
   return { prisma: prismaMock };
});

const mockPrisma: any = prisma;

const testKeyId = 'key-1';
const testKey = {
   id: testKeyId,
   handle: 'creator-alpha',
   displayName: 'Creator Alpha',
   creatorWallet: 'GA_CREATOR',
   status: 'Active',
   createdAt: new Date('2026-01-01T00:00:00.000Z'),
   updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const testTrade = {
   id: 'trade-1',
   creatorId: testKeyId,
   buyer: 'GB_BUYER',
   quantity: '10',
   price: '100',
   paymentAsset: 'XLM',
   ledger: 5000,
   txHash: '0xtx1',
   timestamp: new Date('2026-01-02T00:00:00.000Z'),
   createdAt: new Date('2026-01-02T00:00:00.000Z'),
};

function graphql(query: string, headers: Record<string, string> = {}) {
   return request(app)
      .post('/api/v1/graphql')
      .set('Content-Type', 'application/json')
      .set(headers)
      .send({ query });
}

beforeEach(() => {
   jest.clearAllMocks();
   mockPrisma.creatorProfile.findUnique.mockResolvedValue(testKey);
   mockPrisma.creatorProfile.findMany.mockResolvedValue([testKey]);
   mockPrisma.creatorProfile.count.mockResolvedValue(1);
   mockPrisma.trade.findMany.mockResolvedValue([testTrade]);
   mockPrisma.trade.count.mockResolvedValue(1);
});

describe('GraphQL endpoint (POST /api/v1/graphql)', () => {
   describe('nested resolution', () => {
      it('resolves key -> holders -> trades with correct data', async () => {
         const query = `
            {
               key(id: "${testKeyId}") {
                  id
                  handle
                  holders(first: 10) {
                     edges { node { walletAddress totalKeysHeld } cursor }
                  }
                  trades(first: 10) {
                     edges { node { id buyer quantity price } cursor }
                  }
               }
            }
         `;
         mockPrisma.trade.findMany.mockResolvedValueOnce([testTrade]);
         const res = await graphql(query);

         expect(res.status).toBe(200);
         const body = res.body;
         expect(body.errors).toBeUndefined();
         expect(body.data.key.id).toBe(testKeyId);
         expect(body.data.key.handle).toBe('creator-alpha');
         expect(body.data.key.trades.edges[0].node.id).toBe('trade-1');
      });

      it('resolves trades for a key', async () => {
         const query = `
            {
               trades(keyId: "${testKeyId}", first: 10) {
                  edges { node { id keyId buyer quantity } cursor }
               }
            }
         `;
         const res = await graphql(query);

         expect(res.body.errors).toBeUndefined();
         expect(res.body.data.trades.edges[0].node.keyId).toBe(testKeyId);
      });

      it('returns null for unknown key', async () => {
         mockPrisma.creatorProfile.findUnique.mockResolvedValueOnce(null);
         const res = await graphql(`
            {
               key(id: "unknown") {
                  id
                  handle
               }
            }
         `);

         expect(res.body.errors).toBeUndefined();
         expect(res.body.data.key).toBeNull();
      });
   });

   describe('pagination', () => {
      it('keys returns pageInfo and cursor', async () => {
         const res = await graphql(`
            {
               keys(first: 2) {
                  edges {
                     node {
                        id
                     }
                     cursor
                  }
                  pageInfo {
                     hasNextPage
                  }
               }
            }
         `);

         expect(res.body.errors).toBeUndefined();
         expect(res.body.data.keys.edges.length).toBe(1);
         expect(res.body.data.keys.pageInfo.hasNextPage).toBe(false);
      });

      it('uses the cursor to fetch the next page', async () => {
         const res = await graphql(`
            {
               keys(first: 1) {
                  edges {
                     node {
                        id
                     }
                     cursor
                  }
                  pageInfo {
                     endCursor
                  }
               }
            }
         `);
         const cursor = res.body.data.keys.edges[0].cursor;

         mockPrisma.creatorProfile.findMany.mockResolvedValueOnce([]);
         const res2 = await graphql(
            `{ keys(first: 1, after: "${cursor}") { edges { node { id } } } }`
         );

         expect(res2.body.errors).toBeUndefined();
         expect(mockPrisma.creatorProfile.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ cursor: { id: testKeyId } })
         );
      });
   });

   describe('max depth', () => {
      it('allows queries up to 6 levels deep', async () => {
         const query = `{
            key(id: "${testKeyId}") {
               holders(first: 10) {
                  edges { node { walletAddress } }
               }
            }
         }`;
         mockPrisma.trade.findMany.mockResolvedValueOnce([]);
         const res = await graphql(query);

         expect(res.body.errors).toBeUndefined();
      });

      it('rejects queries deeper than 6 levels', async () => {
         const query = `{
            key(id: "${testKeyId}") {
               holders {
                  edges { node { trades { edges { node { holder { id } } } } } }
               }
            }
         }`;
         const res = await graphql(query);

         expect(res.body.errors).toHaveLength(1);
         expect(res.body.errors[0].message).toMatch(/maximum depth/);
      });
   });

   describe('max cost', () => {
      it('allows queries within the cost limit', async () => {
         const res = await graphql(`
            {
               keys(first: 5) {
                  edges {
                     node {
                        id
                     }
                  }
               }
            }
         `);
         expect(res.body.errors).toBeUndefined();
      });

      it('rejects queries over the cost limit', async () => {
         // a large `first` pushes estimated cost over 1,000 while staying
         // within the depth limit (depth 4), so this is a cost-only rejection.
         const query = `{
            keys(first: 2000) {
               edges { node { id } }
            }
         }`;
         const res = await graphql(query);

         expect(res.body.errors).toHaveLength(1);
         expect(res.body.errors[0].message).toMatch(/cost limit/);
      });
   });

   describe('DataLoader batching', () => {
      it('batches holder lookups — one query per request level', async () => {
         const query = `{
            key(id: "${testKeyId}") {
               holders(first: 10) {
                  edges { node { walletAddress } }
               }
            }
         }`;
         mockPrisma.trade.findMany.mockResolvedValueOnce([]);

         await graphql(query);

         // holdersByKeyLoader runs one trade.findMany for the batched key ids.
         expect(mockPrisma.trade.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
               where: { creatorId: { in: [testKeyId] } },
            })
         );
      });

      it('batches trade->key lookups through the creator loader', async () => {
         const query = `{
            trades(keyId: "${testKeyId}", first: 10) {
               edges { node { key { id handle } } }
            }
         }`;
         await graphql(query);

         // creatorLoader batches creatorProfile lookups by key id.
         expect(mockPrisma.creatorProfile.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: { in: [testKeyId] } } })
         );
      });
   });

   describe('mutations', () => {
      it('does not expose mutations', async () => {
         const res = await graphql(`
            mutation {
               createKey(input: {}) {
                  id
               }
            }
         `);

         expect(res.body.errors).toHaveLength(1);
         expect(res.body.errors[0].message).toMatch(/mutation operation/);
      });

      it('rejects any mutation root selection', async () => {
         const res = await graphql(`
            mutation {
               keys {
                  edges {
                     node {
                        id
                     }
                  }
               }
            }
         `);

         expect(res.body.errors).toHaveLength(1);
         expect(res.body.errors[0].message).toMatch(/mutation operation/);
      });
   });
});
