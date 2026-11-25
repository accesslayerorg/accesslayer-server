// src/modules/protocol/fee-change.service.test.ts

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      pendingFeeChange: {
         findUnique: jest.fn(),
         findFirst: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
      },
      feeConfigHistory: {
         upsert: jest.fn(),
         findFirst: jest.fn(),
         findMany: jest.fn(),
      },
      protocolConfig: {
         findUnique: jest.fn(),
         upsert: jest.fn(),
      },
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   processProtocolFeeChangeEvents,
   getProtocolFeesState,
   getProtocolFeesHistory,
   FeeService,
   setFeeAlertWebhookSender,
} from './fee-change.service';

const mockPrisma = prisma as any;

describe('fee-change.service', () => {
   const webhookSpy = jest.fn(async () => {});

   beforeEach(() => {
      jest.clearAllMocks();
      setFeeAlertWebhookSender(webhookSpy);
   });

   afterEach(() => {
      setFeeAlertWebhookSender(null);
   });

   it('processes fee_change_queued idempotently and notifies alert webhook', async () => {
      mockPrisma.pendingFeeChange.findUnique.mockResolvedValueOnce(null);
      mockPrisma.pendingFeeChange.create.mockResolvedValue({ id: 'pfc-1' });

      const event = {
         eventType: 'fee_change_queued',
         changeId: 'chg-1',
         protocolFeeBps: 350,
         creatorFeeBps: 150,
         ledger: 1000,
         executeAfterLedger: 2000,
         txHash: '0xqueue',
         eventIndex: 0,
         timestamp: '2026-11-24T12:00:00Z',
      };

      await processProtocolFeeChangeEvents([event as any]);

      expect(mockPrisma.pendingFeeChange.create).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               changeId: 'chg-1',
               protocolFeeBps: 350,
               queuedLedger: 1000,
               executeAfterLedger: 2000,
               status: 'PENDING',
            }),
         })
      );
      expect(webhookSpy).toHaveBeenCalledTimes(1);
      expect(webhookSpy).toHaveBeenCalledWith(
         expect.objectContaining({
            event: 'fee_change_queued',
            changeId: 'chg-1',
            protocolFeeBps: 350,
            executeAfterLedger: 2000,
         })
      );

      // Replay of same event should be a no-op and not re-notify webhook
      mockPrisma.pendingFeeChange.findUnique.mockResolvedValueOnce({ id: 'pfc-1' });
      await processProtocolFeeChangeEvents([event as any]);
      expect(mockPrisma.pendingFeeChange.create).toHaveBeenCalledTimes(1);
      expect(webhookSpy).toHaveBeenCalledTimes(1);
   });

   it('processes fee_change_executed idempotently and writes FeeConfigHistory', async () => {
      mockPrisma.pendingFeeChange.findUnique.mockResolvedValue({
         id: 'pfc-1',
         changeId: 'chg-1',
         protocolFeeBps: 350,
         creatorFeeBps: 150,
         feeTiers: null,
         resolvedTxHash: null,
         resolvedEventIndex: null,
      });

      await processProtocolFeeChangeEvents([
         {
            eventType: 'fee_change_executed',
            changeId: 'chg-1',
            protocolFeeBps: 350,
            ledger: 2005,
            txHash: '0xexec',
            eventIndex: 1,
            timestamp: '2026-11-24T13:24:00Z',
         } as any,
      ]);

      expect(mockPrisma.pendingFeeChange.update).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { id: 'pfc-1' },
            data: expect.objectContaining({ status: 'EXECUTED', resolvedLedger: 2005 }),
         })
      );
      expect(mockPrisma.feeConfigHistory.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            create: expect.objectContaining({
               protocolFeeBps: 350,
               effectiveLedger: 2005,
            }),
         })
      );
      expect(mockPrisma.protocolConfig.upsert).toHaveBeenCalled();
   });

   it('processes fee_change_cancelled idempotently', async () => {
      mockPrisma.pendingFeeChange.findUnique.mockResolvedValue({
         id: 'pfc-2',
         changeId: 'chg-2',
         resolvedTxHash: null,
         resolvedEventIndex: null,
      });

      await processProtocolFeeChangeEvents([
         {
            eventType: 'fee_change_cancelled',
            changeId: 'chg-2',
            ledger: 1500,
            txHash: '0xcancel',
            eventIndex: 0,
         } as any,
      ]);

      expect(mockPrisma.pendingFeeChange.update).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { id: 'pfc-2' },
            data: expect.objectContaining({ status: 'CANCELLED', resolvedLedger: 1500 }),
         })
      );
   });

   it('returns current config and pending change from getProtocolFeesState', async () => {
      mockPrisma.protocolConfig.findUnique.mockResolvedValue({
         protocolFeeBps: 500,
         feeTiers: [],
      });
      mockPrisma.feeConfigHistory.findFirst.mockResolvedValue({
         protocolFeeBps: 400,
         creatorFeeBps: 100,
         feeTiers: null,
         effectiveLedger: 900,
         effectiveAt: new Date('2026-11-24T10:00:00Z'),
      });
      mockPrisma.pendingFeeChange.findFirst.mockResolvedValue({
         id: 'pfc-1',
         changeId: 'chg-1',
         protocolFeeBps: 350,
         creatorFeeBps: 150,
         feeTiers: null,
         queuedLedger: 1000,
         executeAfterLedger: 2000,
         estimatedExecuteAt: new Date('2026-11-24T13:23:20Z'),
         status: 'PENDING',
         createdAt: new Date('2026-11-24T12:00:00Z'),
      });

      const state = await getProtocolFeesState();
      expect(state.current.protocolFeeBps).toBe(400);
      expect(state.pending?.executeAfterLedger).toBe(2000);
      expect(state.pending?.estimatedExecuteAt).toBe('2026-11-24T13:23:20.000Z');
   });

   it('paginates fee history with cursor', async () => {
      mockPrisma.feeConfigHistory.findMany.mockResolvedValue([
         { id: 'h3', effectiveLedger: 300 },
         { id: 'h2', effectiveLedger: 200 },
         { id: 'h1', effectiveLedger: 100 },
      ]);

      const page = await getProtocolFeesHistory({ limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBe('h2');
   });

   it('FeeService.at(ledger) returns configuration in force at a given ledger', async () => {
      mockPrisma.feeConfigHistory.findFirst.mockResolvedValue({
         protocolFeeBps: 450,
         creatorFeeBps: 50,
         feeTiers: null,
         effectiveLedger: 800,
         effectiveAt: new Date('2026-11-20T00:00:00Z'),
      });

      const cfg = await FeeService.at(1250);
      expect(cfg.protocolFeeBps).toBe(450);
      expect(cfg.effectiveLedger).toBe(800);
      expect(mockPrisma.feeConfigHistory.findFirst).toHaveBeenCalledWith({
         where: { effectiveLedger: { lte: 1250 } },
         orderBy: [{ effectiveLedger: 'desc' }, { createdAt: 'desc' }],
      });
   });
});
