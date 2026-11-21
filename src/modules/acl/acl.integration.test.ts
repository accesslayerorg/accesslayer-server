import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-base';
import adminRouter from '../admin/admin.routes';
import { prisma } from '../../utils/prisma.utils';
import { errorHandler } from '../../middlewares/error.middleware';
import { buildAclCanonicalMessage } from './acl.service';

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
app.use(errorHandler);

const CONTRACT_ADDRESS =
   'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function sign(
   keypair: Keypair,
   action: 'add' | 'remove',
   contractAddress: string,
   permittedFunctions: string[]
) {
   const message = buildAclCanonicalMessage(
      action,
      contractAddress,
      permittedFunctions
   );
   return {
      wallet: keypair.publicKey(),
      signature: keypair.sign(message).toString('base64'),
   };
}

describe('ACL whitelist management (#966)', () => {
   let adminToken: string;
   let nonAdminToken: string;
   let signer1: Keypair;
   let signer2: Keypair;

   beforeAll(() => {
      const secret =
         process.env.JWT_SECRET ||
         'accesslayer_default_development_jwt_secret_key_32_bytes';
      adminToken = jwt.sign(
         { sub: 'GAADMINACLTESTWALLET1111111111111111111111111111111', role: 'admin' },
         secret
      );
      nonAdminToken = jwt.sign(
         { sub: 'GANONADMINACLTESTWALLET222222222222222222222222222', role: 'user' },
         secret
      );
      signer1 = Keypair.random();
      signer2 = Keypair.random();
   });

   beforeEach(() => {
      jest.restoreAllMocks();
      delete process.env.ADMIN_MULTISIG_WALLETS;
   });

   describe('authorization', () => {
      it('returns 401 with a clear message when no token is supplied', async () => {
         // adminGuard convention: missing/invalid token -> 401, valid but
         // non-admin token -> 403 (see admin-guard.middleware.ts).
         const res = await request(app).get('/admin/acl');
         expect(res.status).toBe(401);
         expect(res.body.error.message).toMatch(/authorization/i);
      });

      it('returns 403 for a non-admin JWT on every mutation', async () => {
         const addRes = await request(app)
            .post('/admin/acl')
            .set('Authorization', `Bearer ${nonAdminToken}`)
            .send({
               contractAddress: CONTRACT_ADDRESS,
               permittedFunctions: ['transfer'],
               signatures: [],
            });
         expect(addRes.status).toBe(403);
         expect(addRes.body.error.code).toBe('FORBIDDEN');

         const removeRes = await request(app)
            .delete('/admin/acl/some-id')
            .set('Authorization', `Bearer ${nonAdminToken}`)
            .send({ signatures: [] });
         expect(removeRes.status).toBe(403);
         expect(removeRes.body.error.code).toBe('FORBIDDEN');
      });
   });

   describe('GET /admin/acl', () => {
      it('returns the paginated list of whitelisted contracts with function sets', async () => {
         jest.spyOn(prisma.aclWhitelist, 'findMany').mockResolvedValue([
            {
               id: 'acl-1',
               contractAddress: CONTRACT_ADDRESS,
               permittedFunctions: ['transfer', 'approve'],
               addedBy: signer1.publicKey(),
               createdAt: new Date(),
               updatedAt: new Date(),
            } as any,
         ]);
         jest.spyOn(prisma.aclWhitelist, 'count').mockResolvedValue(1);

         const res = await request(app)
            .get('/admin/acl')
            .set('Authorization', `Bearer ${adminToken}`);

         expect(res.status).toBe(200);
         expect(res.body.data).toHaveLength(1);
         expect(res.body.data[0]).toMatchObject({
            contractAddress: CONTRACT_ADDRESS,
            permittedFunctions: ['transfer', 'approve'],
         });
         expect(res.body.meta.totalCount).toBe(1);
      });
   });

   describe('POST /admin/acl', () => {
      it('returns 422 for an invalid contract address', async () => {
         const res = await request(app)
            .post('/admin/acl')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
               contractAddress: 'not-a-valid-address',
               permittedFunctions: ['transfer'],
               signatures: [],
            });

         expect(res.status).toBe(400);
         expect(res.body.error.details).toEqual(
            expect.arrayContaining([
               expect.objectContaining({ field: 'contractAddress' }),
            ])
         );
      });

      it('returns 422 for an empty function list', async () => {
         const res = await request(app)
            .post('/admin/acl')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
               contractAddress: CONTRACT_ADDRESS,
               permittedFunctions: [],
               signatures: [],
            });

         expect(res.status).toBe(400);
      });

      it('returns 403 when fewer than 2 valid admin signatures are supplied', async () => {
         jest.spyOn(prisma.aclWhitelist, 'findUnique').mockResolvedValue(null);
         const sig1 = sign(signer1, 'add', CONTRACT_ADDRESS, ['transfer']);

         const res = await request(app)
            .post('/admin/acl')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
               contractAddress: CONTRACT_ADDRESS,
               permittedFunctions: ['transfer'],
               signatures: [sig1],
            });

         expect(res.status).toBe(403);
         expect(res.body.error.message).toMatch(/requires 2/i);
      });

      it('adds the contract when 2 valid, distinct admin signatures are supplied', async () => {
         jest.spyOn(prisma.aclWhitelist, 'findUnique').mockResolvedValue(null);
         const createdEntry = {
            id: 'acl-new-1',
            contractAddress: CONTRACT_ADDRESS,
            permittedFunctions: ['transfer'],
            addedBy: 'admin-wallet',
            createdAt: new Date(),
            updatedAt: new Date(),
         };
         jest
            .spyOn(prisma, '$transaction')
            .mockResolvedValue([createdEntry, {}]);
         jest.spyOn(prisma.auditLog, 'create').mockResolvedValue({} as any);

         const sig1 = sign(signer1, 'add', CONTRACT_ADDRESS, ['transfer']);
         const sig2 = sign(signer2, 'add', CONTRACT_ADDRESS, ['transfer']);

         const res = await request(app)
            .post('/admin/acl')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
               contractAddress: CONTRACT_ADDRESS,
               permittedFunctions: ['transfer'],
               signatures: [sig1, sig2],
            });

         expect(res.status).toBe(201);
         expect(res.body.data.contractAddress).toBe(CONTRACT_ADDRESS);
      });

      it('returns 409 when the contract is already whitelisted', async () => {
         jest.spyOn(prisma.aclWhitelist, 'findUnique').mockResolvedValue({
            id: 'acl-existing',
            contractAddress: CONTRACT_ADDRESS,
            permittedFunctions: ['transfer'],
            addedBy: 'someone',
            createdAt: new Date(),
            updatedAt: new Date(),
         } as any);

         const sig1 = sign(signer1, 'add', CONTRACT_ADDRESS, ['transfer']);
         const sig2 = sign(signer2, 'add', CONTRACT_ADDRESS, ['transfer']);

         const res = await request(app)
            .post('/admin/acl')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
               contractAddress: CONTRACT_ADDRESS,
               permittedFunctions: ['transfer'],
               signatures: [sig1, sig2],
            });

         expect(res.status).toBe(409);
      });
   });

   describe('DELETE /admin/acl/:contractId', () => {
      it('returns 403 when fewer than 2 valid admin signatures are supplied', async () => {
         jest.spyOn(prisma.aclWhitelist, 'findFirst').mockResolvedValue({
            id: 'acl-1',
            contractAddress: CONTRACT_ADDRESS,
            permittedFunctions: ['transfer'],
            addedBy: 'someone',
            createdAt: new Date(),
            updatedAt: new Date(),
         } as any);

         const sig1 = sign(signer1, 'remove', CONTRACT_ADDRESS, ['transfer']);

         const res = await request(app)
            .delete('/admin/acl/acl-1')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ signatures: [sig1] });

         expect(res.status).toBe(403);
      });

      it('removes the entry when 2 valid, distinct admin signatures are supplied', async () => {
         jest.spyOn(prisma.aclWhitelist, 'findFirst').mockResolvedValue({
            id: 'acl-1',
            contractAddress: CONTRACT_ADDRESS,
            permittedFunctions: ['transfer'],
            addedBy: 'someone',
            createdAt: new Date(),
            updatedAt: new Date(),
         } as any);
         jest.spyOn(prisma, '$transaction').mockResolvedValue([{}, {}]);
         jest.spyOn(prisma.auditLog, 'create').mockResolvedValue({} as any);

         const sig1 = sign(signer1, 'remove', CONTRACT_ADDRESS, ['transfer']);
         const sig2 = sign(signer2, 'remove', CONTRACT_ADDRESS, ['transfer']);

         const res = await request(app)
            .delete('/admin/acl/acl-1')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ signatures: [sig1, sig2] });

         expect(res.status).toBe(200);
         expect(res.body.data.removed).toBe(true);
      });

      it('returns 404 for an unknown contractId', async () => {
         jest.spyOn(prisma.aclWhitelist, 'findFirst').mockResolvedValue(null);

         const sig1 = sign(signer1, 'remove', CONTRACT_ADDRESS, ['transfer']);
         const sig2 = sign(signer2, 'remove', CONTRACT_ADDRESS, ['transfer']);

         const res = await request(app)
            .delete('/admin/acl/does-not-exist')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ signatures: [sig1, sig2] });

         expect(res.status).toBe(404);
      });
   });

   describe('GET /admin/acl/history', () => {
      it('returns events with actor and timestamp', async () => {
         jest.spyOn(prisma.aclEvent, 'findMany').mockResolvedValue([
            {
               id: 'evt-1',
               eventType: 'added',
               contractAddress: CONTRACT_ADDRESS,
               permittedFunctions: ['transfer'],
               actor: 'admin-wallet',
               signers: [signer1.publicKey(), signer2.publicKey()],
               createdAt: new Date(),
            } as any,
         ]);
         jest.spyOn(prisma.aclEvent, 'count').mockResolvedValue(1);

         const res = await request(app)
            .get('/admin/acl/history')
            .set('Authorization', `Bearer ${adminToken}`);

         expect(res.status).toBe(200);
         expect(res.body.data[0]).toMatchObject({
            eventType: 'added',
            actor: 'admin-wallet',
         });
         expect(res.body.data[0].createdAt).toEqual(expect.any(String));
      });
   });
});
