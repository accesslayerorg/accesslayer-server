jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      multisigAction: {
         findMany: jest.fn(),
         findUnique: jest.fn(),
      },
      multisigActionSignature: {
         findMany: jest.fn(),
      },
   },
}));

import express from 'express';
import request from 'supertest';
import multisigRouter from './multisig.routes';
import { prisma } from '../../utils/prisma.utils';

const multisigActionFindMany = (prisma as any).multisigAction.findMany as jest.Mock;
const multisigActionFindUnique = (prisma as any).multisigAction.findUnique as jest.Mock;

const app = express();
app.use(express.json());
app.use('/multisig', multisigRouter);

describe('Multisig REST API (#1085)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('GET /multisig/actions/pending', () => {
      it('returns list of pending actions with signature count and threshold', async () => {
         multisigActionFindMany.mockResolvedValue([
            {
               actionId: 'action-1',
               description: 'Upgrade contract',
               target: 'GBXX...',
               functionName: 'upgrade',
               status: 'pending',
               threshold: 2,
               totalSigners: 3,
               proposedBy: 'GPROP...',
               proposedAt: new Date('2026-10-19T10:00:00Z'),
               signatures: [{ signer: 'GSIGN1...' }],
            },
         ]);

         const res = await request(app).get('/multisig/actions/pending');
         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toHaveLength(1);
         expect(res.body.data[0]).toEqual({
            action_id: 'action-1',
            description: 'Upgrade contract',
            target: 'GBXX...',
            function_name: 'upgrade',
            status: 'pending',
            signature_count: 1,
            threshold: 2,
            total_signers: 3,
            proposed_by: 'GPROP...',
            proposed_at: '2026-10-19T10:00:00.000Z',
         });
      });
   });

   describe('GET /multisig/actions/history', () => {
      it('returns history of executed and expired actions with outcomes', async () => {
         multisigActionFindMany.mockResolvedValue([
            {
               actionId: 'action-0',
               description: 'Fee update',
               target: 'GBXX...',
               functionName: 'setFee',
               status: 'executed',
               outcome: 'success',
               threshold: 2,
               proposedBy: 'GPROP...',
               proposedAt: new Date('2026-10-18T10:00:00Z'),
               executedAt: new Date('2026-10-18T11:00:00Z'),
               expiredAt: null,
               signatures: [{ signer: 'GSIGN1...' }, { signer: 'GSIGN2...' }],
            },
         ]);

         const res = await request(app).get('/multisig/actions/history');
         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toHaveLength(1);
         expect(res.body.data[0].status).toBe('executed');
         expect(res.body.data[0].outcome).toBe('success');
         expect(res.body.data[0].signature_count).toBe(2);
      });
   });

   describe('GET /multisig/actions/:action_id', () => {
      it('returns single action detail with signers and params', async () => {
         multisigActionFindUnique.mockResolvedValue({
            actionId: 'action-1',
            description: 'Upgrade contract',
            target: 'GBXX...',
            functionName: 'upgrade',
            params: { version: '2.0.0' },
            status: 'pending',
            threshold: 2,
            totalSigners: 3,
            proposedBy: 'GPROP...',
            proposedAt: new Date('2026-10-19T10:00:00Z'),
            executedAt: null,
            expiredAt: null,
            outcome: null,
            txHash: '0xabc',
            signatures: [
               {
                  signer: 'GSIGN1...',
                  signedAt: new Date('2026-10-19T10:05:00Z'),
                  txHash: '0xdef',
               },
            ],
         });

         const res = await request(app).get('/multisig/actions/action-1');
         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.action_id).toBe('action-1');
         expect(res.body.data.params).toEqual({ version: '2.0.0' });
         expect(res.body.data.signers).toHaveLength(1);
         expect(res.body.data.signers[0].signer).toBe('GSIGN1...');
      });

      it('returns 404 when action is not found', async () => {
         multisigActionFindUnique.mockResolvedValue(null);

         const res = await request(app).get('/multisig/actions/nonexistent');
         expect(res.status).toBe(404);
         expect(res.body.success).toBe(false);
      });
   });
});
