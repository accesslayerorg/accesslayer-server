// src/modules/multisig/__tests__/multisig-actions.service.test.ts

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: {
      multisigAction: {
         findMany: jest.fn(),
         findUnique: jest.fn(),
         count: jest.fn(),
      },
   },
}));

import { prisma } from '../../../utils/prisma.utils';
import {
   getPendingActions,
   getActionDetail,
   getActionHistory,
   MultisigActionNotFoundError,
   validateSignerEligibility,
} from '../multisig-actions.service';

const mockPrisma = prisma as unknown as {
   multisigAction: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
   };
};

const VALID_STELLAR_ADDR = 'GA37PRKUOWJN5DWJWBCBLAH4WWHWEQQKSKFQGSIEPKT3VJUE5DVQHSXT';

describe('Multisig Actions Service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('getPendingActions', () => {
      it('should return pending actions with signature counts', async () => {
         mockPrisma.multisigAction.findMany.mockResolvedValue([
            {
               actionId: 'act-1',
               changeType: 'upgrade',
               payload: { v: 1 },
               status: 'pending',
               threshold: 2,
               totalSigners: 3,
               signatures: [{ signer: VALID_STELLAR_ADDR, signedAt: new Date() }],
               proposedBy: VALID_STELLAR_ADDR,
               proposedAt: new Date(),
               ledger: 100,
               txHash: 'tx-1',
            },
         ]);

         const result = await getPendingActions();
         expect(result).toHaveLength(1);
         expect(result[0].actionId).toBe('act-1');
         expect(result[0].signatureCount).toBe(1);
         expect(result[0].status).toBe('pending');
      });
   });

   describe('getActionDetail', () => {
      it('should return action detail when found', async () => {
         mockPrisma.multisigAction.findUnique.mockResolvedValue({
            actionId: 'act-2',
            changeType: 'config',
            payload: { key: 'val' },
            status: 'pending',
            threshold: 2,
            totalSigners: 3,
            signatures: [],
            proposedBy: VALID_STELLAR_ADDR,
            proposedAt: new Date(),
            executedAt: null,
            expiredAt: null,
            ledger: 101,
            txHash: 'tx-2',
         });

         const result = await getActionDetail('act-2');
         expect(result.actionId).toBe('act-2');
         expect(result.params).toEqual({ key: 'val' });
         expect(result.signatureCount).toBe(0);
      });

      it('should throw MultisigActionNotFoundError when not found', async () => {
         mockPrisma.multisigAction.findUnique.mockResolvedValue(null);

         await expect(getActionDetail('unknown')).rejects.toThrow(MultisigActionNotFoundError);
      });
   });

   describe('getActionHistory', () => {
      it('should return history with pagination', async () => {
         mockPrisma.multisigAction.findMany.mockResolvedValue([
            {
               actionId: 'act-3',
               changeType: 'param',
               payload: {},
               status: 'executed',
               threshold: 2,
               totalSigners: 3,
               signatures: [],
               proposedBy: VALID_STELLAR_ADDR,
               proposedAt: new Date(),
               executedAt: new Date(),
               expiredAt: null,
               ledger: 102,
               txHash: 'tx-3',
            },
         ]);
         mockPrisma.multisigAction.count.mockResolvedValue(1);

         const result = await getActionHistory({ page: 1, limit: 10 });
         expect(result.history).toHaveLength(1);
         expect(result.history[0].status).toBe('executed');
         expect(result.pagination.total).toBe(1);
      });
   });

   describe('validateSignerEligibility', () => {
      it('should validate Stellar address format', async () => {
         const valid = await validateSignerEligibility(VALID_STELLAR_ADDR);
         expect(valid).toBe(true);

         const invalid = await validateSignerEligibility('INVALID');
         expect(invalid).toBe(false);
      });
   });
});
