// src/modules/multisig/__tests__/multisig-actions.integration.test.ts

import request from 'supertest';
import express from 'express';
import multisigRouter from '../multisig.routes';
import { errorHandler } from '../../../middlewares/error.middleware';
import { prisma } from '../../../utils/prisma.utils';

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: {
      multisigAction: {
         findMany: jest.fn(),
         findUnique: jest.fn(),
         count: jest.fn(),
      },
   },
}));

const mockPrisma = prisma as unknown as {
   multisigAction: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
   };
};

const app = express();
app.use(express.json());
app.use('/multisig', multisigRouter);
app.use(errorHandler);

const VALID_STELLAR_ADDR = 'GABUYER00000000000000000000000000000000000000000000000000';

describe('Multisig Action REST API (#1085)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('GET /multisig/actions/pending', () => {
      it('returns empty list when no pending actions exist', async () => {
         mockPrisma.multisigAction.findMany.mockResolvedValue([]);

         const res = await request(app).get('/multisig/actions/pending');

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.actions).toEqual([]);
      });

      it('returns pending actions with accurate signature count and threshold', async () => {
         mockPrisma.multisigAction.findMany.mockResolvedValue([
            {
               actionId: 'act-pending-1',
               changeType: 'update_limit',
               payload: { limit: 100 },
               status: 'pending',
               threshold: 2,
               totalSigners: 3,
               proposedBy: VALID_STELLAR_ADDR,
               signatures: [
                  { signer: VALID_STELLAR_ADDR, signedAt: new Date(), ledger: 10, txHash: 'tx-s1' },
               ],
               proposedAt: new Date(),
               ledger: 10,
               txHash: 'tx-p1',
            },
         ]);

         const res = await request(app).get('/multisig/actions/pending');

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.actions).toHaveLength(1);
         expect(res.body.data.actions[0]).toMatchObject({
            actionId: 'act-pending-1',
            changeType: 'update_limit',
            status: 'pending',
            threshold: 2,
            totalSigners: 3,
            signatureCount: 1,
         });
         expect(res.body.data.actions[0].signatures).toHaveLength(1);
      });
   });

   describe('GET /multisig/actions/:action_id', () => {
      it('returns 404 when action does not exist', async () => {
         mockPrisma.multisigAction.findUnique.mockResolvedValue(null);

         const res = await request(app).get('/multisig/actions/nonexistent');

         expect(res.status).toBe(404);
         expect(res.body.success).toBe(false);
      });

      it('returns correct action detail with signer list and parameter data', async () => {
         mockPrisma.multisigAction.findUnique.mockResolvedValue({
            actionId: 'act-detail-1',
            changeType: 'upgrade_contract',
            payload: { contractHash: 'abc123hash' },
            status: 'pending',
            threshold: 2,
            totalSigners: 3,
            proposedBy: VALID_STELLAR_ADDR,
            signatures: [
               { signer: VALID_STELLAR_ADDR, signedAt: new Date(), ledger: 10, txHash: 'tx-s1' },
               { signer: VALID_STELLAR_ADDR, signedAt: new Date(), ledger: 11, txHash: 'tx-s2' },
            ],
            proposedAt: new Date(),
            executedAt: null,
            expiredAt: null,
            ledger: 10,
            txHash: 'tx-p1',
         });

         const res = await request(app).get('/multisig/actions/act-detail-1');

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toMatchObject({
            actionId: 'act-detail-1',
            changeType: 'upgrade_contract',
            status: 'pending',
            threshold: 2,
            totalSigners: 3,
            signatureCount: 2,
         });
         expect(res.body.data.signatures).toHaveLength(2);
         expect(res.body.data.params).toEqual({ contractHash: 'abc123hash' });
      });
   });

   describe('GET /multisig/actions/history', () => {
      it('returns accurate completed and expired records', async () => {
         mockPrisma.multisigAction.findMany.mockResolvedValue([
            {
               actionId: 'act-exec-1',
               changeType: 'change_owner',
               payload: { newOwner: VALID_STELLAR_ADDR },
               status: 'executed',
               threshold: 2,
               totalSigners: 3,
               proposedBy: VALID_STELLAR_ADDR,
               signatures: [],
               proposedAt: new Date(),
               executedAt: new Date('2026-10-20T11:00:00.000Z'),
               expiredAt: null,
               ledger: 15,
               txHash: 'tx-exec',
            },
            {
               actionId: 'act-exp-1',
               changeType: 'deprecated_action',
               payload: {},
               status: 'expired',
               threshold: 2,
               totalSigners: 3,
               proposedBy: VALID_STELLAR_ADDR,
               signatures: [],
               proposedAt: new Date(),
               executedAt: null,
               expiredAt: new Date('2026-10-20T12:00:00.000Z'),
               ledger: 16,
               txHash: 'tx-exp',
            },
         ]);
         mockPrisma.multisigAction.count.mockResolvedValue(2);

         const res = await request(app).get('/multisig/actions/history');

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.history).toHaveLength(2);
         expect(res.body.data.pagination.total).toBe(2);
         expect(res.body.data.history).toEqual(
            expect.arrayContaining([
               expect.objectContaining({ actionId: 'act-exec-1', status: 'executed' }),
               expect.objectContaining({ actionId: 'act-exp-1', status: 'expired' }),
            ])
         );
      });
   });
});
