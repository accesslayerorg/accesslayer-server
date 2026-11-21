// src/modules/swaps/__tests__/swaps.service.test.ts
// Unit tests for atomic swaps service layer (#1087)

import { prisma } from '../../../utils/prisma.utils';
import {
   formatSwapRecord,
   fetchOutgoingSwaps,
   fetchIncomingSwaps,
   fetchSwapById,
} from '../swaps.service';

describe('SwapsService', () => {
   const proposer = 'GA_PROPOSER_TEST_123';
   const counterparty = 'GB_COUNTERPARTY_TEST_456';
   const baseTime = new Date('2026-10-18T10:00:00.000Z');

   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('formatSwapRecord', () => {
      it('formats swap record with accurate offered and requested key/amount data and live countdown', () => {
         const expiresAt = new Date(baseTime.getTime() + 1800 * 1000); // 30 minutes in future
         const row = {
            id: 'swap-rec-1',
            swapId: 'swap-1',
            proposer,
            counterparty,
            offeredKey: 'creator-alpha',
            offeredAmount: '250',
            requestedKey: 'creator-beta',
            requestedAmount: '125',
            status: 'pending',
            expiresAt,
            proposedAt: baseTime,
            executedAt: null,
            cancelledAt: null,
            ledger: 5000,
            txHash: '0x123',
            createdAt: baseTime,
            updatedAt: baseTime,
         };

         const formatted = formatSwapRecord(row, baseTime);

         expect(formatted.swapId).toBe('swap-1');
         expect(formatted.swap_id).toBe('swap-1');
         expect(formatted.proposer).toBe(proposer);
         expect(formatted.counterparty).toBe(counterparty);

         // Offered & requested accurate data
         expect(formatted.offeredKey).toBe('creator-alpha');
         expect(formatted.offeredAmount).toBe('250');
         expect(formatted.requestedKey).toBe('creator-beta');
         expect(formatted.requestedAmount).toBe('125');
         expect(formatted.offered).toEqual({
            key: 'creator-alpha',
            amount: '250',
         });
         expect(formatted.requested).toEqual({
            key: 'creator-beta',
            amount: '125',
         });

         // Status & Countdown
         expect(formatted.status).toBe('pending');
         expect(formatted.isExpired).toBe(false);
         expect(formatted.expiryCountdown).toBe(1800); // 1800 seconds remaining
         expect(formatted.expiry_countdown).toBe(1800);
      });

      it('marks status as expired and countdown 0 when expiresAt has passed', () => {
         const expiresAt = new Date(baseTime.getTime() - 1000); // 1 second in past
         const row = {
            id: 'swap-rec-2',
            swapId: 'swap-2',
            proposer,
            counterparty,
            offeredKey: 'creator-alpha',
            offeredAmount: '10',
            requestedKey: 'creator-beta',
            requestedAmount: '5',
            status: 'pending',
            expiresAt,
            proposedAt: new Date(baseTime.getTime() - 3601 * 1000),
            ledger: 4900,
            txHash: '0xpast',
         };

         const formatted = formatSwapRecord(row, baseTime);

         expect(formatted.status).toBe('expired');
         expect(formatted.isExpired).toBe(true);
         expect(formatted.expiryCountdown).toBe(0);
      });
   });

   describe('fetchOutgoingSwaps', () => {
      it('returns paginated outgoing proposals for the proposer wallet with status and expiry countdown', async () => {
         const expiresAt = new Date(baseTime.getTime() + 3600 * 1000);
         const mockRows = [
            {
               id: 'rec-1',
               swapId: 'swap-out-1',
               proposer,
               counterparty,
               offeredKey: 'key-a',
               offeredAmount: '100',
               requestedKey: 'key-b',
               requestedAmount: '50',
               status: 'pending',
               expiresAt,
               proposedAt: baseTime,
               ledger: 5010,
               txHash: '0xtx1',
            },
         ];

         const mockFindMany = jest.fn().mockResolvedValue(mockRows);
         const mockCount = jest.fn().mockResolvedValue(1);
         const mockUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

         (prisma as any).atomicSwap = {
            findMany: mockFindMany,
            count: mockCount,
            updateMany: mockUpdateMany,
         };

         const result = await fetchOutgoingSwaps(
            proposer,
            { page: 1, limit: 10, offset: 0 },
            prisma
         );

         expect(mockFindMany).toHaveBeenCalledWith({
            where: { proposer },
            orderBy: [
               { proposedAt: 'desc' },
               { ledger: 'desc' },
               { id: 'desc' },
            ],
            skip: 0,
            take: 10,
         });

         expect(result.items).toHaveLength(1);
         expect(result.total).toBe(1);
         expect(result.meta.page).toBe(1);
         expect(result.items[0].swapId).toBe('swap-out-1');
         expect(result.items[0].proposer).toBe(proposer);
         expect(result.items[0].expiryCountdown).toBeGreaterThan(0);
      });
   });

   describe('fetchIncomingSwaps', () => {
      it('returns incoming proposals awaiting acceptance for counterparty wallet', async () => {
         const expiresAt = new Date(Date.now() + 3600 * 1000);
         const mockRows = [
            {
               id: 'rec-2',
               swapId: 'swap-in-1',
               proposer,
               counterparty,
               offeredKey: 'key-x',
               offeredAmount: '30',
               requestedKey: 'key-y',
               requestedAmount: '15',
               status: 'pending',
               expiresAt,
               proposedAt: baseTime,
               ledger: 5020,
               txHash: '0xtx2',
            },
         ];

         const mockFindMany = jest.fn().mockResolvedValue(mockRows);
         const mockCount = jest.fn().mockResolvedValue(1);
         const mockUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

         (prisma as any).atomicSwap = {
            findMany: mockFindMany,
            count: mockCount,
            updateMany: mockUpdateMany,
         };

         const result = await fetchIncomingSwaps(
            counterparty,
            { page: 1, limit: 20, offset: 0 },
            prisma
         );

         expect(mockFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
               where: expect.objectContaining({
                  counterparty,
                  status: 'pending',
                  expiresAt: expect.objectContaining({
                     gt: expect.any(Date),
                  }),
               }),
            })
         );

         expect(result.items).toHaveLength(1);
         expect(result.items[0].counterparty).toBe(counterparty);
         expect(result.items[0].status).toBe('pending');
      });
   });

   describe('fetchSwapById', () => {
      it('returns accurate single swap proposal detail', async () => {
         const expiresAt = new Date(Date.now() + 3600 * 1000);
         const mockRow = {
            id: 'swap-db-10',
            swapId: 'swap-10',
            proposer,
            counterparty,
            offeredKey: 'key-gold',
            offeredAmount: '500',
            requestedKey: 'key-silver',
            requestedAmount: '1000',
            status: 'pending',
            expiresAt,
            proposedAt: baseTime,
            ledger: 5050,
            txHash: '0xdetail_tx',
         };

         const mockFindUnique = jest.fn().mockResolvedValue(mockRow);
         (prisma as any).atomicSwap = {
            findUnique: mockFindUnique,
         };

         const swap = await fetchSwapById('swap-10', prisma);

         expect(swap).not.toBeNull();
         expect(swap!.swapId).toBe('swap-10');
         expect(swap!.offeredKey).toBe('key-gold');
         expect(swap!.offeredAmount).toBe('500');
         expect(swap!.requestedKey).toBe('key-silver');
         expect(swap!.requestedAmount).toBe('1000');
         expect(swap!.offered).toEqual({ key: 'key-gold', amount: '500' });
         expect(swap!.requested).toEqual({ key: 'key-silver', amount: '1000' });
      });

      it('returns null for non-existent swapId', async () => {
         const mockFindUnique = jest.fn().mockResolvedValue(null);
         const mockFindFirst = jest.fn().mockResolvedValue(null);
         (prisma as any).atomicSwap = {
            findUnique: mockFindUnique,
            findFirst: mockFindFirst,
         };

         const swap = await fetchSwapById('non-existent-id', prisma);
         expect(swap).toBeNull();
      });
   });
});
