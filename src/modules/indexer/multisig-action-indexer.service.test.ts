// src/modules/indexer/multisig-action-indexer.service.test.ts

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      multisigAction: {
         upsert: jest.fn(),
         updateMany: jest.fn(),
      },
      signature: {
         create: jest.fn(),
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
import { processMultisigActionEvents } from './multisig-action-indexer.service';

const mockPrisma = prisma as unknown as {
   multisigAction: {
      upsert: jest.Mock;
      updateMany: jest.Mock;
   };
   signature: {
      create: jest.Mock;
   };
};

const VALID_STELLAR_ADDR = 'GA37PRKUOWJN5DWJWBCBLAH4WWHWEQQKSKFQGSIEPKT3VJUE5DVQHSXT';

beforeEach(() => {
   jest.clearAllMocks();
   mockPrisma.multisigAction.upsert.mockResolvedValue({ id: 'action-1' });
   mockPrisma.signature.create.mockResolvedValue({ id: 'sig-1' });
   mockPrisma.multisigAction.updateMany.mockResolvedValue({ count: 1 });
});

describe('processMultisigActionEvents', () => {
   it('indexes ActionProposed event correctly', async () => {
      const event = {
         eventType: 'ActionProposed',
         actionId: 'act-101',
         changeType: 'upgrade',
         payload: { version: '2.0' },
         threshold: 2,
         totalSigners: 3,
         proposedBy: VALID_STELLAR_ADDR,
         ledger: 1000,
         txHash: 'tx-prop-1',
         eventIndex: 0,
         occurredAt: '2026-10-20T10:00:00.000Z',
      };

      await processMultisigActionEvents([event]);

      expect(mockPrisma.multisigAction.upsert).toHaveBeenCalledWith({
         where: { actionId: 'act-101' },
         create: expect.objectContaining({
            actionId: 'act-101',
            changeType: 'upgrade',
            threshold: 2,
            totalSigners: 3,
            status: 'pending',
            proposedBy: VALID_STELLAR_ADDR,
            ledger: 1000,
            txHash: 'tx-prop-1',
         }),
         update: expect.any(Object),
      });
   });

   it('indexes ActionSigned event correctly', async () => {
      const event = {
         eventType: 'ActionSigned',
         actionId: 'act-101',
         signer: VALID_STELLAR_ADDR,
         ledger: 1001,
         txHash: 'tx-sig-1',
         eventIndex: 1,
         occurredAt: '2026-10-20T10:05:00.000Z',
      };

      await processMultisigActionEvents([event]);

      expect(mockPrisma.signature.create).toHaveBeenCalledWith({
         data: expect.objectContaining({
            actionId: 'act-101',
            signer: VALID_STELLAR_ADDR,
            ledger: 1001,
            txHash: 'tx-sig-1',
         }),
      });
   });

   it('indexes ActionExecuted event correctly', async () => {
      const event = {
         eventType: 'ActionExecuted',
         actionId: 'act-101',
         status: 'executed',
         ledger: 1002,
         txHash: 'tx-exec-1',
         eventIndex: 2,
         occurredAt: '2026-10-20T10:10:00.000Z',
      };

      await processMultisigActionEvents([event]);

      expect(mockPrisma.multisigAction.updateMany).toHaveBeenCalledWith({
         where: { actionId: 'act-101' },
         data: expect.objectContaining({
            status: 'executed',
         }),
      });
   });

   it('ignores duplicate events in the same batch', async () => {
      const event = {
         eventType: 'ActionProposed',
         actionId: 'act-102',
         proposedBy: VALID_STELLAR_ADDR,
         ledger: 1000,
         txHash: 'tx-prop-2',
         eventIndex: 0,
      };

      await processMultisigActionEvents([event, event]);

      expect(mockPrisma.multisigAction.upsert).toHaveBeenCalledTimes(1);
   });
});
