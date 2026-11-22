jest.unmock('@prisma/client');

import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Keypair } from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import { buildAuthHeaders } from '../../utils/test/auth-request.utils';
import { airdropAdminRouter, airdropRouter } from './airdrop.routes';
import { MerkleService } from './merkle.service';
import { processAirdropClaimEvents } from '../indexer/airdrop-indexer.service';

const describeDatabase = process.env.RUN_AIRDROP_INTEGRATION === '1' ? describe : describe.skip;
const fixture = 'airdrop-1278-' + randomUUID();
const creator = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 71));
const recipients = [72, 73, 74].map(seed => Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)));
const allocations = recipients.map((wallet, index) => ({
   address: wallet.publicKey(),
   amount: index === 0 ? '170141183460469231731687303715884105727' : String(index + 1),
}));
const body = { keyId: fixture, allocations };
const app = express();
app.use(express.json());
app.use('/v1/admin/airdrops', airdropAdminRouter);
app.use('/v1/airdrops', airdropRouter);

describeDatabase('airdrop database and signed HTTP lifecycle', () => {
   beforeAll(async () => {
      await prisma.user.create({
         data: {
            id: fixture, email: fixture + '@example.test',
            passwordHash: 'integration-fixture', firstName: 'Airdrop', lastName: 'Creator',
         },
      });
      await prisma.stellarWallet.create({
         data: { address: creator.publicKey(), userId: fixture },
      });
      await prisma.creatorProfile.create({
         data: { id: fixture, userId: fixture, handle: fixture, displayName: 'Airdrop test' },
      });
   });

   afterAll(async () => {
      await prisma.airdrop.deleteMany({ where: { keyId: fixture } });
      await prisma.creatorProfile.deleteMany({ where: { id: fixture } });
      await prisma.stellarWallet.deleteMany({ where: { userId: fixture } });
      await prisma.user.deleteMany({ where: { id: fixture } });
      await prisma.$disconnect();
   });

   it('creates a tree, serves proofs, and exposes exactly one replay-safe claim', async () => {
      const created = await request(app).post('/v1/admin/airdrops')
         .set(buildAuthHeaders(body, creator)).send(body);
      expect(created.status).toBe(201);
      const { id, root } = created.body.data;
      expect(created.body.data.allocationCount).toBe(3);

      const replay = await request(app).post('/v1/admin/airdrops')
         .set(buildAuthHeaders(body, creator)).send(body);
      expect(replay.body.data.id).toBe(id);
      expect(await prisma.airdropLeaf.count({ where: { airdropId: id } })).toBe(3);

      for (const allocation of allocations) {
         const proof = await request(app).get('/v1/airdrops/' + id + '/proof')
            .query({ address: allocation.address });
         expect(proof.status).toBe(200);
         expect(proof.body.data.amount).toBe(allocation.amount);
         expect(proof.body.data.claimed).toBe(false);
         expect(MerkleService.verify(allocation, proof.body.data.proof, root)).toBe(true);
      }
      const ineligible = await request(app).get('/v1/airdrops/' + id + '/proof')
         .query({ address: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 75)).publicKey() });
      expect(ineligible.status).toBe(404);

      const claim = {
         eventType: 'airdrop_claimed', txHash: fixture + '-claim',
         eventIndex: 0, ledger: 100, keyId: fixture, root,
         address: allocations[0].address, amount: allocations[0].amount,
         claimedAt: '2026-11-21T00:00:00Z',
      };
      await processAirdropClaimEvents([claim, claim]);
      await processAirdropClaimEvents([claim]);
      const claims = await request(app).get('/v1/airdrops/' + id + '/claims');
      expect(claims.status).toBe(200);
      expect(claims.body.data.items.map((leaf: { claimed: boolean }) => leaf.claimed)).toEqual([true, false, false]);
      expect(claims.body.data.items[0].amount).toBe(allocations[0].amount);
      expect(await prisma.airdropLeaf.count({ where: { airdropId: id, claimedAt: { not: null } } })).toBe(1);

      const page = await request(app).get('/v1/airdrops/' + id + '/claims').query({ limit: 1 });
      expect(page.body.data.items).toHaveLength(1);
      const next = await request(app).get('/v1/airdrops/' + id + '/claims')
         .query({ limit: 1, cursor: page.body.data.nextCursor });
      expect(next.body.data.items[0].index).toBe(1);
   });

   it('rejects allocations signed by another creator', async () => {
      const attacker = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 76));
      const response = await request(app).post('/v1/admin/airdrops')
         .set(buildAuthHeaders(body, attacker)).send(body);
      expect(response.status).toBe(403);
   });
});
