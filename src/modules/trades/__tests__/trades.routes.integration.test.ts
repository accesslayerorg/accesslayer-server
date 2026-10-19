import request from 'supertest';
import app from '../../../app';
import { prisma } from '../../../utils/prisma.utils';

jest.setTimeout(30000);

// Mock prisma for isolated API integration tests
jest.mock('../../../utils/prisma.utils', () => ({
   prisma: {
      trade: {
         findMany: jest.fn(),
         count: jest.fn(),
      },
      bundleTrade: {
         findMany: jest.fn(),
         count: jest.fn(),
      },
   },
}));

describe('Trades REST API Endpoints (/trades/:wallet and /trades/:wallet/bundles)', () => {
   const testWallet =
      'GBUYER11111111111111111111111111111111111111111111111111';

   const mockBundleTrades = [
      {
         id: 'bundle-1',
         wallet: testWallet,
         buyer: testWallet,
         totalCost: '25000',
         itemCount: 2,
         items: [
            {
               key: 'creator-alpha',
               creatorId: 'creator-alpha',
               creator_id: 'creator-alpha',
               amount: 10,
               quantity: 10,
               price: '1000',
            },
            {
               key: 'creator-beta',
               creatorId: 'creator-beta',
               creator_id: 'creator-beta',
               amount: 5,
               quantity: 5,
               price: '3000',
            },
         ],
         ledger: 5002,
         txHash: '0xbundle2',
         timestamp: new Date('2026-10-18T12:00:00.000Z'),
         createdAt: new Date('2026-10-18T12:00:00.000Z'),
      },
      {
         id: 'bundle-2',
         wallet: testWallet,
         buyer: testWallet,
         totalCost: '10000',
         itemCount: 1,
         items: [
            {
               key: 'creator-gamma',
               creatorId: 'creator-gamma',
               creator_id: 'creator-gamma',
               amount: 2,
               quantity: 2,
               price: '5000',
            },
         ],
         ledger: 4998,
         txHash: '0xbundle1',
         timestamp: new Date('2026-10-18T10:00:00.000Z'),
         createdAt: new Date('2026-10-18T10:00:00.000Z'),
      },
   ];

   const mockSingleTrades = [
      {
         id: 'trade-1',
         buyer: testWallet,
         creatorId: 'creator-solo',
         quantity: '1',
         price: '7000',
         ledger: 5001,
         txHash: '0xsingle1',
         paymentAsset: 'XLM',
         timestamp: new Date('2026-10-18T11:00:00.000Z'),
         createdAt: new Date('2026-10-18T11:00:00.000Z'),
         type: 'single',
      },
      {
         id: 'trade-2',
         buyer: testWallet,
         creatorId: 'creator-solo2',
         quantity: '4',
         price: '2000',
         ledger: 4995,
         txHash: '0xsingle2',
         paymentAsset: 'USDC',
         timestamp: new Date('2026-10-18T09:00:00.000Z'),
         createdAt: new Date('2026-10-18T09:00:00.000Z'),
         type: 'single',
      },
   ];

   beforeEach(() => {
      jest.clearAllMocks();
      (prisma.bundleTrade.findMany as jest.Mock).mockResolvedValue(
         mockBundleTrades
      );
      (prisma.trade.findMany as jest.Mock).mockResolvedValue(mockSingleTrades);
   });

   describe('GET /trades/:wallet/bundles — paginated bundle trade history', () => {
      it('returns 200 with paginated bundle trade history and full per-item breakdown', async () => {
         const res = await request(app)
            .get(`/trades/${testWallet}/bundles`)
            .expect(200);

         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toHaveLength(2);

         const first = res.body.data.items[0];
         expect(first.id).toBe('bundle-1');
         expect(first.type).toBe('bundle');
         expect(first.wallet).toBe(testWallet);
         expect(first.total_cost).toBe('25000');
         expect(first.item_count).toBe(2);
         expect(first.ledger).toBe(5002);
         expect(first.tx_hash).toBe('0xbundle2');
         expect(first.timestamp).toBeDefined();

         // Per-item breakdown
         expect(first.items).toHaveLength(2);
         expect(first.items[0].key).toBe('creator-alpha');
         expect(first.items[0].amount).toBe(10);
         expect(first.items[0].price).toBe('1000');
         expect(first.items[1].key).toBe('creator-beta');
         expect(first.items[1].amount).toBe(5);
         expect(first.items[1].price).toBe('3000');

         // Pagination meta
         expect(res.body.data.meta).toBeDefined();
         expect(res.body.data.total).toBe(2);
      });

      it('supports limit and offset pagination', async () => {
         const res = await request(app)
            .get(`/trades/${testWallet}/bundles?limit=1&offset=1`)
            .expect(200);

         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toHaveLength(1);
         expect(res.body.data.items[0].id).toBe('bundle-2');
         expect(res.body.data.total).toBe(2);
         expect(res.body.data.meta.limit).toBe(1);
         expect(res.body.data.meta.offset).toBe(1);
      });

      it('supports page query parameter', async () => {
         const res = await request(app)
            .get(`/trades/${testWallet}/bundles?limit=1&page=2`)
            .expect(200);

         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toHaveLength(1);
         expect(res.body.data.items[0].id).toBe('bundle-2');
      });

      it('returns empty list for a wallet with no bundle trades', async () => {
         (prisma.bundleTrade.findMany as jest.Mock).mockResolvedValueOnce([]);

         const res = await request(app)
            .get(
               '/trades/GEMPTYWALLET11111111111111111111111111111111111111111111111/bundles'
            )
            .expect(200);

         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toEqual([]);
         expect(res.body.data.total).toBe(0);
         expect(res.body.data.has_more).toBe(false);
      });

      it('accessible via /api/v1/trades/:wallet/bundles prefix as well', async () => {
         const res = await request(app)
            .get(`/api/v1/trades/${testWallet}/bundles`)
            .expect(200);

         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toHaveLength(2);
      });
   });

   describe('GET /trades/:wallet — standard trade history with type flag', () => {
      it('combines single trades (type: single) and bundle trades (type: bundle) chronologically', async () => {
         const res = await request(app)
            .get(`/trades/${testWallet}`)
            .expect(200);

         expect(res.body.success).toBe(true);
         // Total 4 trades: 2 single + 2 bundle
         expect(res.body.data.items).toHaveLength(4);

         const items = res.body.data.items;
         // Chronological order descending:
         // 1. bundle-1 (12:00)
         // 2. trade-1  (11:00)
         // 3. bundle-2 (10:00)
         // 4. trade-2  (09:00)
         expect(items[0].id).toBe('bundle-1');
         expect(items[0].type).toBe('bundle');
         expect(items[0].items).toBeDefined();

         expect(items[1].id).toBe('trade-1');
         expect(items[1].type).toBe('single');
         expect(items[1].creator_id).toBe('creator-solo');

         expect(items[2].id).toBe('bundle-2');
         expect(items[2].type).toBe('bundle');

         expect(items[3].id).toBe('trade-2');
         expect(items[3].type).toBe('single');
         expect(items[3].creator_id).toBe('creator-solo2');
      });

      it('filters by ?type=bundle returning only bundle trades', async () => {
         const res = await request(app)
            .get(`/trades/${testWallet}?type=bundle`)
            .expect(200);

         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toHaveLength(2);
         expect(
            res.body.data.items.every((it: any) => it.type === 'bundle')
         ).toBe(true);
      });

      it('filters by ?type=single returning only single trades', async () => {
         const res = await request(app)
            .get(`/trades/${testWallet}?type=single`)
            .expect(200);

         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toHaveLength(2);
         expect(
            res.body.data.items.every((it: any) => it.type === 'single')
         ).toBe(true);
      });

      it('supports pagination on standard trades endpoint', async () => {
         const res = await request(app)
            .get(`/trades/${testWallet}?limit=2&offset=0`)
            .expect(200);

         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toHaveLength(2);
         expect(res.body.data.total).toBe(4);
         expect(res.body.data.has_more).toBe(true);
         expect(res.body.data.cursor).toBeDefined();
      });

      it('accessible via /api/v1/trades/:wallet as well', async () => {
         const res = await request(app)
            .get(`/api/v1/trades/${testWallet}`)
            .expect(200);

         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toHaveLength(4);
      });
   });
});
