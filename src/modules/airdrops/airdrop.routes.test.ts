import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-base';
import { buildAuthHeaders } from '../../utils/test/auth-request.utils';
import { airdropAdminRouter, airdropRouter } from './airdrop.routes';
import { createAirdrop, getAirdropProof, listAirdropClaims } from './airdrop.service';

jest.mock('./airdrop.service', () => ({
   createAirdrop: jest.fn(),
   getAirdropProof: jest.fn(),
   listAirdropClaims: jest.fn(),
   AirdropRequestError: class extends Error {},
}));
jest.mock('../nonce', () => ({
   validateSignedActionNonce: jest.fn(),
   NonceAlreadyConsumedError: class extends Error {},
   NonceMismatchError: class extends Error {},
}));

const creator = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const recipient = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const body = { keyId: 'key', allocations: [{ address: recipient.publicKey(), amount: '10' }] };
const app = express();
app.use(express.json());
app.use('/admin/airdrops', airdropAdminRouter);
app.use('/airdrops', airdropRouter);

describe('airdrop HTTP boundaries', () => {
   beforeEach(() => jest.clearAllMocks());

   it('requires a creator signature and binds it to the allocations', async () => {
      expect((await request(app).post('/admin/airdrops').send(body)).status).toBe(401);
      expect((await request(app).post('/admin/airdrops')
         .set(buildAuthHeaders(body, creator))
         .send({ ...body, allocations: [{ address: recipient.publicKey(), amount: '20' }] })
      ).status).toBe(403);
      expect(createAirdrop).not.toHaveBeenCalled();
   });

   it('passes the verified creator and validated allocations to persistence', async () => {
      (createAirdrop as jest.Mock).mockResolvedValue({ id: 'drop', root: 'a'.repeat(64) });
      const response = await request(app).post('/admin/airdrops')
         .set(buildAuthHeaders(body, creator)).send(body);
      expect(response.status).toBe(201);
      expect(createAirdrop).toHaveBeenCalledWith(body, creator.publicKey());
      expect(response.body.data.root).toBe('a'.repeat(64));
   });

   it('rejects signed zero and duplicate allocations', async () => {
      for (const allocations of [
         [{ address: recipient.publicKey(), amount: '0' }],
         [body.allocations[0], body.allocations[0]],
      ]) {
         const invalidBody = { ...body, allocations };
         const response = await request(app).post('/admin/airdrops')
            .set(buildAuthHeaders(invalidBody, creator)).send(invalidBody);
         expect(response.status).toBe(400);
      }
      expect(createAirdrop).not.toHaveBeenCalled();
   });

   it('returns 404 for an ineligible address and 400 for malformed queries', async () => {
      (getAirdropProof as jest.Mock).mockResolvedValue(null);
      expect((await request(app).get('/airdrops/drop/proof')
         .query({ address: recipient.publicKey() })).status).toBe(404);
      expect((await request(app).get('/airdrops/drop/proof')
         .query({ address: 'invalid' })).status).toBe(400);
   });

   it('serves claim eligibility and indexed claim flags', async () => {
      (getAirdropProof as jest.Mock).mockResolvedValue({
         amount: '10', index: 0, proof: [], claimed: true,
      });
      (listAirdropClaims as jest.Mock).mockResolvedValue({
         items: [{ address: recipient.publicKey(), amount: '10', index: 0, claimed: true }],
         nextCursor: null,
      });
      const proof = await request(app).get('/airdrops/drop/proof')
         .query({ address: recipient.publicKey() });
      expect(proof.status).toBe(200);
      expect(proof.body.data.claimed).toBe(true);
      const claims = await request(app).get('/airdrops/drop/claims');
      expect(claims.status).toBe(200);
      expect(claims.body.data.items[0].claimed).toBe(true);
   });
});
