// src/modules/indexer/atomic-swap-indexer.service.test.ts
// Unit tests for atomic swap contract event indexer and expiry marking (#1087)

jest.mock('./ledger-gap-detection.service', () => ({
   updateIndexedLedger: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../utils/prisma.utils';
import { updateIndexedLedger } from './ledger-gap-detection.service';
import {
   processSwapProposedEvent,
   processSwapExecutedEvent,
   processSwapCancelledEvent,
   processAtomicSwapEvent,
   processSwapEvents,
   markExpiredSwaps,
   SwapProposedEvent,
   SwapExecutedEvent,
   SwapCancelledEvent,
   DEFAULT_SWAP_EXPIRY_MS,
} from './atomic-swap-indexer.service';

const checkpointMock = updateIndexedLedger as jest.Mock;

describe('AtomicSwapIndexerService', () => {
   const testSwapId = 'swap-test-101';
   const proposer = 'GA_PROPOSER_WALLET_1234567890';
   const counterparty = 'GB_COUNTERPARTY_WALLET_1234567890';
   const now = new Date('2026-10-18T10:00:00.000Z');

   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('processSwapProposedEvent', () => {
      it('persists a valid SwapProposed event into atomic_swaps with default 1h expiry', async () => {
         const mockFindUnique = jest.fn().mockResolvedValue(null);
         const mockCreate = jest.fn().mockResolvedValue({ id: 'swap-db-1' });
         const mockUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

         (prisma as any).atomicSwap = {
            findUnique: mockFindUnique,
            create: mockCreate,
            updateMany: mockUpdateMany,
         };

         const event: SwapProposedEvent = {
            eventType: 'SwapProposed',
            swapId: testSwapId,
            proposer,
            counterparty,
            offeredKey: 'creator-key-alpha',
            offeredAmount: '100',
            requestedKey: 'creator-key-beta',
            requestedAmount: '50',
            ledger: 5000,
            txHash: '0xtx_proposed_1',
            eventIndex: 0,
            timestamp: now.toISOString(),
         };

         const result = await processSwapProposedEvent(event, prisma);

         expect(result).toBe(true);
         expect(mockFindUnique).toHaveBeenCalledWith({
            where: { swapId: testSwapId },
            select: { id: true },
         });
         expect(mockCreate).toHaveBeenCalledTimes(1);

         const createArg = mockCreate.mock.calls[0][0];
         expect(createArg.data.swapId).toBe(testSwapId);
         expect(createArg.data.proposer).toBe(proposer);
         expect(createArg.data.counterparty).toBe(counterparty);
         expect(createArg.data.offeredKey).toBe('creator-key-alpha');
         expect(createArg.data.offeredAmount).toBe('100');
         expect(createArg.data.requestedKey).toBe('creator-key-beta');
         expect(createArg.data.requestedAmount).toBe('50');
         expect(createArg.data.status).toBe('pending');
         expect(createArg.data.ledger).toBe(5000);
         expect(createArg.data.txHash).toBe('0xtx_proposed_1');

         // Verify default 1h expiry (proposedAt + 1h = 3600000 ms)
         const expectedExpiresAt = new Date(
            now.getTime() + DEFAULT_SWAP_EXPIRY_MS
         );
         expect(createArg.data.expiresAt.getTime()).toBe(
            expectedExpiresAt.getTime()
         );
      });

      it('respects an explicit expiresAt in the event', async () => {
         const customExpiry = new Date('2026-10-18T10:30:00.000Z');
         const mockFindUnique = jest.fn().mockResolvedValue(null);
         const mockCreate = jest
            .fn()
            .mockResolvedValue({ id: 'swap-db-custom' });
         const mockUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

         (prisma as any).atomicSwap = {
            findUnique: mockFindUnique,
            create: mockCreate,
            updateMany: mockUpdateMany,
         };

         const event: SwapProposedEvent = {
            eventType: 'SwapProposed',
            swapId: 'swap-custom-exp',
            proposer,
            counterparty,
            offeredKey: 'key-1',
            offeredAmount: '10',
            requestedKey: 'key-2',
            requestedAmount: '20',
            expiresAt: customExpiry.toISOString(),
            ledger: 5005,
            txHash: '0xcustom_exp',
            eventIndex: 0,
            timestamp: now.toISOString(),
         };

         const result = await processSwapProposedEvent(event, prisma);

         expect(result).toBe(true);
         const createArg = mockCreate.mock.calls[0][0];
         expect(createArg.data.expiresAt.getTime()).toBe(
            customExpiry.getTime()
         );
      });

      it('skips duplicate proposals idempotently if swapId already exists in DB', async () => {
         const mockFindUnique = jest
            .fn()
            .mockResolvedValue({ id: 'existing-swap' });
         const mockCreate = jest.fn();

         (prisma as any).atomicSwap = {
            findUnique: mockFindUnique,
            create: mockCreate,
         };

         const event: SwapProposedEvent = {
            eventType: 'SwapProposed',
            swapId: testSwapId,
            proposer,
            counterparty,
            offeredKey: 'key-1',
            offeredAmount: '10',
            requestedKey: 'key-2',
            requestedAmount: '20',
            ledger: 5000,
            txHash: '0xdup',
            eventIndex: 0,
            timestamp: now.toISOString(),
         };

         const result = await processSwapProposedEvent(event, prisma);

         expect(result).toBe(false);
         expect(mockCreate).not.toHaveBeenCalled();
      });

      it('skips malformed events missing required fields', async () => {
         const mockCreate = jest.fn();
         (prisma as any).atomicSwap = { create: mockCreate };

         // Missing proposer
         const badEvent: Partial<SwapProposedEvent> = {
            eventType: 'SwapProposed',
            swapId: 'swap-incomplete',
            counterparty,
            offeredKey: 'k1',
            offeredAmount: '1',
            requestedKey: 'k2',
            requestedAmount: '2',
            ledger: 5000,
            txHash: '0xtx',
         };

         const result = await processSwapProposedEvent(badEvent, prisma);
         expect(result).toBe(false);
         expect(mockCreate).not.toHaveBeenCalled();
      });

      it('guards against in-batch duplicates when seen set is provided', async () => {
         const seen = new Set<string>();
         const mockFindUnique = jest.fn().mockResolvedValue(null);
         const mockCreate = jest.fn().mockResolvedValue({ id: 'id-1' });
         const mockUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

         (prisma as any).atomicSwap = {
            findUnique: mockFindUnique,
            create: mockCreate,
            updateMany: mockUpdateMany,
         };

         const event: SwapProposedEvent = {
            eventType: 'SwapProposed',
            swapId: 'swap-dedupe-1',
            proposer,
            counterparty,
            offeredKey: 'k1',
            offeredAmount: '10',
            requestedKey: 'k2',
            requestedAmount: '5',
            ledger: 5010,
            txHash: '0xtx_dedupe',
            eventIndex: 1,
            timestamp: now.toISOString(),
         };

         const first = await processSwapProposedEvent(event, prisma, seen);
         const second = await processSwapProposedEvent(event, prisma, seen);

         expect(first).toBe(true);
         expect(second).toBe(false);
         expect(mockCreate).toHaveBeenCalledTimes(1);
      });
   });

   describe('processSwapExecutedEvent', () => {
      it('updates existing atomic swap to executed with timestamp', async () => {
         const executedAt = new Date('2026-10-18T10:15:00.000Z');
         const mockFindUnique = jest.fn().mockResolvedValue({
            id: 'swap-1',
            swapId: testSwapId,
            status: 'pending',
         });
         const mockUpdate = jest.fn().mockResolvedValue({
            id: 'swap-1',
            status: 'executed',
         });
         const mockUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

         (prisma as any).atomicSwap = {
            findUnique: mockFindUnique,
            update: mockUpdate,
            updateMany: mockUpdateMany,
         };

         const event: SwapExecutedEvent = {
            eventType: 'SwapExecuted',
            swapId: testSwapId,
            ledger: 5020,
            txHash: '0xexecuted_tx',
            eventIndex: 0,
            timestamp: executedAt.toISOString(),
         };

         const result = await processSwapExecutedEvent(event, prisma);

         expect(result).toBe(true);
         expect(mockUpdate).toHaveBeenCalledWith({
            where: { swapId: testSwapId },
            data: {
               status: 'executed',
               executedAt,
            },
         });
      });

      it('skips malformed SwapExecuted events', async () => {
         const mockUpdate = jest.fn();
         (prisma as any).atomicSwap = { update: mockUpdate };

         const badEvent: Partial<SwapExecutedEvent> = {
            eventType: 'SwapExecuted',
            swapId: '',
            ledger: 5020,
         };

         const result = await processSwapExecutedEvent(badEvent, prisma);
         expect(result).toBe(false);
         expect(mockUpdate).not.toHaveBeenCalled();
      });
   });

   describe('processSwapCancelledEvent', () => {
      it('updates existing atomic swap to cancelled with timestamp', async () => {
         const cancelledAt = new Date('2026-10-18T10:20:00.000Z');
         const mockFindUnique = jest.fn().mockResolvedValue({
            id: 'swap-1',
            swapId: testSwapId,
            status: 'pending',
         });
         const mockUpdate = jest.fn().mockResolvedValue({
            id: 'swap-1',
            status: 'cancelled',
         });
         const mockUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

         (prisma as any).atomicSwap = {
            findUnique: mockFindUnique,
            update: mockUpdate,
            updateMany: mockUpdateMany,
         };

         const event: SwapCancelledEvent = {
            eventType: 'SwapCancelled',
            swapId: testSwapId,
            ledger: 5030,
            txHash: '0xcancelled_tx',
            eventIndex: 0,
            timestamp: cancelledAt.toISOString(),
         };

         const result = await processSwapCancelledEvent(event, prisma);

         expect(result).toBe(true);
         expect(mockUpdate).toHaveBeenCalledWith({
            where: { swapId: testSwapId },
            data: {
               status: 'cancelled',
               cancelledAt,
            },
         });
      });

      it('skips malformed SwapCancelled events', async () => {
         const mockUpdate = jest.fn();
         (prisma as any).atomicSwap = { update: mockUpdate };

         const badEvent: Partial<SwapCancelledEvent> = {
            eventType: 'SwapCancelled',
            swapId: 'swap-1',
            txHash: '',
         };

         const result = await processSwapCancelledEvent(badEvent, prisma);
         expect(result).toBe(false);
         expect(mockUpdate).not.toHaveBeenCalled();
      });
   });

   describe('markExpiredSwaps', () => {
      it('marks pending swaps whose expiresAt is past asOf date to expired', async () => {
         const mockUpdateMany = jest.fn().mockResolvedValue({ count: 3 });
         (prisma as any).atomicSwap = { updateMany: mockUpdateMany };

         const checkTime = new Date('2026-10-18T11:00:01.000Z');
         const count = await markExpiredSwaps(prisma, checkTime);

         expect(count).toBe(3);
         expect(mockUpdateMany).toHaveBeenCalledWith({
            where: {
               status: 'pending',
               expiresAt: {
                  lte: checkTime,
               },
            },
            data: {
               status: 'expired',
            },
         });
      });
   });

   describe('processSwapEvents (batch)', () => {
      it('processes all three event types, marks expired swaps, and checkpoints ledger with no gaps', async () => {
         const mockFindUnique = jest.fn().mockResolvedValue(null);
         const mockCreate = jest.fn().mockResolvedValue({ id: 'swap-1' });
         const mockUpdate = jest.fn().mockResolvedValue({});
         const mockUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

         (prisma as any).atomicSwap = {
            findUnique: mockFindUnique,
            create: mockCreate,
            update: mockUpdate,
            updateMany: mockUpdateMany,
         };

         const events = [
            {
               eventType: 'SwapProposed' as const,
               swapId: 'swap-batch-1',
               proposer,
               counterparty,
               offeredKey: 'k1',
               offeredAmount: '10',
               requestedKey: 'k2',
               requestedAmount: '20',
               ledger: 6001,
               txHash: '0xbatch_p',
               eventIndex: 0,
               timestamp: now.toISOString(),
            },
            {
               eventType: 'SwapExecuted' as const,
               swapId: 'swap-batch-2',
               ledger: 6005,
               txHash: '0xbatch_e',
               eventIndex: 0,
               timestamp: now.toISOString(),
            },
            {
               eventType: 'SwapCancelled' as const,
               swapId: 'swap-batch-3',
               ledger: 6010,
               txHash: '0xbatch_c',
               eventIndex: 0,
               timestamp: now.toISOString(),
            },
         ];

         await processSwapEvents(events, prisma);

         // All 3 events processed
         expect(mockCreate).toHaveBeenCalled();
         // Checkpointed highest ledger: 6010
         expect(checkpointMock).toHaveBeenCalledWith(
            6010,
            '6010-000',
            expect.any(String)
         );
         // markExpiredSwaps called
         expect(mockUpdateMany).toHaveBeenCalled();
      });
   });

   describe('processAtomicSwapEvent', () => {
      it('dispatches to appropriate handler or ignores unknown events', async () => {
         const mockFindUnique = jest.fn().mockResolvedValue(null);
         const mockCreate = jest.fn().mockResolvedValue({ id: 'swap-disp' });
         (prisma as any).atomicSwap = {
            findUnique: mockFindUnique,
            create: mockCreate,
         };

         const proposed = await processAtomicSwapEvent(
            {
               eventType: 'SwapProposed',
               swapId: 'swap-disp-1',
               proposer,
               counterparty,
               offeredKey: 'k1',
               offeredAmount: '10',
               requestedKey: 'k2',
               requestedAmount: '20',
               ledger: 7000,
               txHash: '0xdisp',
            } as any,
            prisma
         );
         expect(proposed).toBe(true);

         const unknown = await processAtomicSwapEvent(
            { eventType: 'UNKNOWN_EVENT' } as any,
            prisma
         );
         expect(unknown).toBe(false);
      });
   });
});
