// src/modules/swaps/__tests__/swaps.routes.integration.test.ts
// Integration tests for atomic swap proposals REST endpoints (#1087)

import request from 'supertest';
import app from '../../../app';
import { prisma } from '../../../utils/prisma.utils';

describe('Swaps Routes Integration Tests (#1087)', () => {
   const proposerWallet = 'GA_PROPOSER_INTEG_1111111111';
   const counterpartyWallet = 'GB_COUNTERPARTY_INTEG_2222222222';
   const now = new Date();
   const futureExpiry = new Date(now.getTime() + 3600 * 1000);

   const mockOutgoingSwap = {
      id: 'swap-rec-out-1',
      swapId: 'swap-prop-001',
      proposer: proposerWallet,
      counterparty: counterpartyWallet,
      offeredKey: 'creator-alpha-key',
      offeredAmount: '150',
      requestedKey: 'creator-beta-key',
      requestedAmount: '75',
      status: 'pending',
      expiresAt: futureExpiry,
      proposedAt: now,
      executedAt: null,
      cancelledAt: null,
      ledger: 7001,
      txHash: '0xhash_out_1',
      createdAt: now,
      updatedAt: now,
   };

   const mockIncomingSwap = {
      id: 'swap-rec-in-1',
      swapId: 'swap-prop-002',
      proposer: 'GC_ANOTHER_PROPOSER_3333333333',
      counterparty: counterpartyWallet,
      offeredKey: 'creator-gamma-key',
      offeredAmount: '500',
      requestedKey: 'creator-delta-key',
      requestedAmount: '200',
      status: 'pending',
      expiresAt: futureExpiry,
      proposedAt: now,
      executedAt: null,
      cancelledAt: null,
      ledger: 7005,
      txHash: '0xhash_in_1',
      createdAt: now,
      updatedAt: now,
   };

   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('GET /swaps/:wallet/outgoing — paginated outgoing proposals', () => {
      it('returns 200 with paginated outgoing proposals with status and expiry countdown', async () => {
         const mockFindMany = jest.fn().mockResolvedValue([mockOutgoingSwap]);
         const mockCount = jest.fn().mockResolvedValue(1);
         const mockUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

         (prisma as any).atomicSwap = {
            findMany: mockFindMany,
            count: mockCount,
            updateMany: mockUpdateMany,
         };

         const res = await request(app)
            .get(`/swaps/${proposerWallet}/outgoing?page=1&limit=10`)
            .expect(200);

         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toHaveLength(1);

         const proposal = res.body.data.items[0];
         expect(proposal.swapId).toBe('swap-prop-001');
         expect(proposal.proposer).toBe(proposerWallet);
         expect(proposal.counterparty).toBe(counterpartyWallet);
         expect(proposal.offeredKey).toBe('creator-alpha-key');
         expect(proposal.offeredAmount).toBe('150');
         expect(proposal.requestedKey).toBe('creator-beta-key');
         expect(proposal.requestedAmount).toBe('75');
         expect(proposal.status).toBe('pending');
         expect(proposal.expiryCountdown).toBeGreaterThan(0);
         expect(proposal.offered).toEqual({
            key: 'creator-alpha-key',
            amount: '150',
         });
         expect(proposal.requested).toEqual({
            key: 'creator-beta-key',
            amount: '75',
         });

         // Pagination meta
         expect(res.body.data.meta.page).toBe(1);
         expect(res.body.data.meta.limit).toBe(10);
         expect(res.body.data.meta.totalCount).toBe(1);
      });

      it('also works via /api/v1/swaps/:wallet/outgoing', async () => {
         const mockFindMany = jest.fn().mockResolvedValue([mockOutgoingSwap]);
         const mockCount = jest.fn().mockResolvedValue(1);
         const mockUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

         (prisma as any).atomicSwap = {
            findMany: mockFindMany,
            count: mockCount,
            updateMany: mockUpdateMany,
         };

         const res = await request(app)
            .get(`/api/v1/swaps/${proposerWallet}/outgoing`)
            .expect(200);

         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toHaveLength(1);
      });

      it('returns empty list when wallet has no outgoing proposals', async () => {
         const mockFindMany = jest.fn().mockResolvedValue([]);
         const mockCount = jest.fn().mockResolvedValue(0);
         const mockUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

         (prisma as any).atomicSwap = {
            findMany: mockFindMany,
            count: mockCount,
            updateMany: mockUpdateMany,
         };

         const res = await request(app)
            .get(`/swaps/G_EMPTY_WALLET/outgoing`)
            .expect(200);

         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toEqual([]);
         expect(res.body.data.total).toBe(0);
      });
   });

   describe('GET /swaps/:wallet/incoming — paginated incoming proposals', () => {
      it('returns 200 with incoming proposals awaiting acceptance for counterparty wallet', async () => {
         const mockFindMany = jest.fn().mockResolvedValue([mockIncomingSwap]);
         const mockCount = jest.fn().mockResolvedValue(1);
         const mockUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

         (prisma as any).atomicSwap = {
            findMany: mockFindMany,
            count: mockCount,
            updateMany: mockUpdateMany,
         };

         const res = await request(app)
            .get(`/swaps/${counterpartyWallet}/incoming`)
            .expect(200);

         expect(res.body.success).toBe(true);
         expect(res.body.data.items).toHaveLength(1);

         const proposal = res.body.data.items[0];
         expect(proposal.swapId).toBe('swap-prop-002');
         expect(proposal.counterparty).toBe(counterpartyWallet);
         expect(proposal.status).toBe('pending');
         expect(proposal.offeredKey).toBe('creator-gamma-key');
         expect(proposal.offeredAmount).toBe('500');
         expect(proposal.requestedKey).toBe('creator-delta-key');
         expect(proposal.requestedAmount).toBe('200');
         expect(proposal.offered).toEqual({
            key: 'creator-gamma-key',
            amount: '500',
         });
         expect(proposal.requested).toEqual({
            key: 'creator-delta-key',
            amount: '200',
         });
      });
   });

   describe('GET /swaps/:swap_id — single swap proposal detail', () => {
      it('returns 200 with accurate single swap detail with offered and requested data', async () => {
         const mockFindUnique = jest.fn().mockResolvedValue(mockOutgoingSwap);
         (prisma as any).atomicSwap = {
            findUnique: mockFindUnique,
         };

         const res = await request(app).get('/swaps/swap-prop-001').expect(200);

         expect(res.body.success).toBe(true);
         const detail = res.body.data;
         expect(detail.swapId).toBe('swap-prop-001');
         expect(detail.proposer).toBe(proposerWallet);
         expect(detail.counterparty).toBe(counterpartyWallet);
         expect(detail.offeredKey).toBe('creator-alpha-key');
         expect(detail.offeredAmount).toBe('150');
         expect(detail.requestedKey).toBe('creator-beta-key');
         expect(detail.requestedAmount).toBe('75');
         expect(detail.offered).toEqual({
            key: 'creator-alpha-key',
            amount: '150',
         });
         expect(detail.requested).toEqual({
            key: 'creator-beta-key',
            amount: '75',
         });
         expect(detail.status).toBe('pending');
         expect(detail.expiryCountdown).toBeGreaterThan(0);
         expect(detail.ledger).toBe(7001);
         expect(detail.txHash).toBe('0xhash_out_1');
      });

      it('also works via /api/v1/swaps/:swap_id', async () => {
         const mockFindUnique = jest.fn().mockResolvedValue(mockOutgoingSwap);
         (prisma as any).atomicSwap = {
            findUnique: mockFindUnique,
         };

         const res = await request(app)
            .get('/api/v1/swaps/swap-prop-001')
            .expect(200);

         expect(res.body.success).toBe(true);
         expect(res.body.data.swapId).toBe('swap-prop-001');
      });

      it('returns 404 when swap proposal is not found', async () => {
         const mockFindUnique = jest.fn().mockResolvedValue(null);
         const mockFindFirst = jest.fn().mockResolvedValue(null);
         (prisma as any).atomicSwap = {
            findUnique: mockFindUnique,
            findFirst: mockFindFirst,
         };

         const res = await request(app)
            .get('/swaps/non-existent-swap-id')
            .expect(404);

         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('NOT_FOUND');
         expect(res.body.error.message).toContain('Swap proposal not found');
      });
   });
});
