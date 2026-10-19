jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      multisigAction: {
         upsert: jest.fn(),
         updateMany: jest.fn(),
      },
      multisigActionSignature: {
         upsert: jest.fn(),
      },
   },
}));

jest.mock('../../utils/indexer-event-processor.utils', () => ({
   processIndexerChainEvents: jest.fn(async (events: any[], fn: (e: any) => Promise<void>) => {
      for (const event of events) {
         await fn(event);
      }
   }),
}));

import { prisma } from '../../utils/prisma.utils';
import {
   processMultisigActionEvents,
   isMultisigActionEventType,
} from './multisig-actions-indexer.service';

const actionUpsert = (prisma as any).multisigAction.upsert as jest.Mock;
const actionUpdateMany = (prisma as any).multisigAction.updateMany as jest.Mock;
const signatureUpsert = (prisma as any).multisigActionSignature.upsert as jest.Mock;

describe('multisig-actions-indexer.service (#1085)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('isMultisigActionEventType', () => {
      it('recognizes ActionProposed, ActionSigned, and ActionExecuted variants', () => {
         expect(isMultisigActionEventType('ActionProposed')).toBe(true);
         expect(isMultisigActionEventType('ACTION_PROPOSED')).toBe(true);
         expect(isMultisigActionEventType('ActionSigned')).toBe(true);
         expect(isMultisigActionEventType('ACTION_SIGNED')).toBe(true);
         expect(isMultisigActionEventType('ActionExecuted')).toBe(true);
         expect(isMultisigActionEventType('ACTION_EXECUTED')).toBe(true);
         expect(isMultisigActionEventType('UnknownEvent')).toBe(false);
      });
   });

   describe('processMultisigActionEvents', () => {
      it('indexes ActionProposed event into multisig_actions', async () => {
         actionUpsert.mockResolvedValue({});

         await processMultisigActionEvents([
            {
               eventType: 'ActionProposed',
               actionId: 'action-100',
               description: 'Adjust fee rate',
               target: 'GBXX123',
               functionName: 'set_fee',
               params: { bps: 50 },
               threshold: 2,
               totalSigners: 3,
               proposedBy: 'GPROPOSER',
               proposedAt: '2026-10-19T12:00:00Z',
               txHash: '0xprop123',
               ledger: 500,
               eventIndex: 0,
            } as any,
         ]);

         expect(actionUpsert).toHaveBeenCalledTimes(1);
         expect(actionUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
               where: { actionId: 'action-100' },
               create: expect.objectContaining({
                  actionId: 'action-100',
                  description: 'Adjust fee rate',
                  target: 'GBXX123',
                  functionName: 'set_fee',
                  status: 'pending',
                  threshold: 2,
                  totalSigners: 3,
                  proposedBy: 'GPROPOSER',
               }),
            })
         );
      });

      it('indexes ActionSigned event into signatures', async () => {
         signatureUpsert.mockResolvedValue({});

         await processMultisigActionEvents([
            {
               eventType: 'ActionSigned',
               actionId: 'action-100',
               signer: 'GSIGNER1',
               signedAt: '2026-10-19T12:05:00Z',
               txHash: '0xsign123',
               ledger: 501,
               eventIndex: 0,
            } as any,
         ]);

         expect(signatureUpsert).toHaveBeenCalledTimes(1);
         expect(signatureUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
               where: {
                  actionId_signer: {
                     actionId: 'action-100',
                     signer: 'GSIGNER1',
                  },
               },
               create: expect.objectContaining({
                  actionId: 'action-100',
                  signer: 'GSIGNER1',
                  txHash: '0xsign123',
               }),
            })
         );
      });

      it('indexes ActionExecuted event and marks action executed with outcome', async () => {
         actionUpdateMany.mockResolvedValue({ count: 1 });

         await processMultisigActionEvents([
            {
               eventType: 'ActionExecuted',
               actionId: 'action-100',
               outcome: 'success',
               executedAt: '2026-10-19T12:10:00Z',
               txHash: '0xexec123',
               ledger: 502,
               eventIndex: 0,
            } as any,
         ]);

         expect(actionUpdateMany).toHaveBeenCalledTimes(1);
         expect(actionUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
               where: { actionId: 'action-100' },
               data: expect.objectContaining({
                  status: 'executed',
                  outcome: 'success',
                  txHash: '0xexec123',
               }),
            })
         );
      });
   });
});
