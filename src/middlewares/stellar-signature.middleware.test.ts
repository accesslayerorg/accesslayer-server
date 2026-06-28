// src/middlewares/stellar-signature.middleware.test.ts
// Integration test for Stellar signature verification middleware.

import supertest from 'supertest';
import { Keypair } from '@stellar/stellar-base';
import { createHash } from 'crypto';
import app from '../app';
import { prisma } from '../utils/prisma.utils';

const USER_ID = 'sig-test-user-1';
const HANDLE = 'sig-test-creator-1';

function buildCanonicalMessage(body: unknown, timestamp: string): Buffer {
  const bodyJson = JSON.stringify(body);
  const payload = `${bodyJson}${timestamp}`;
  return createHash('sha256').update(payload, 'utf8').digest();
}

describe('#418 Stellar signature verification middleware', () => {
  let creatorId: string;
  let keypair: Keypair;

  beforeAll(async () => {
    keypair = Keypair.random();

    const user = await prisma.user.upsert({
      where: { id: USER_ID },
      create: {
        id: USER_ID,
        email: 'sig-test@example.test',
        passwordHash: 'dummy-hash',
        firstName: 'Sig',
        lastName: 'Test',
      },
      update: {},
    });

    await prisma.stellarWallet.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        address: keypair.publicKey(),
      },
      update: {
        address: keypair.publicKey(),
      },
    });

    const creator = await prisma.creatorProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        handle: HANDLE,
        displayName: 'Sig Test Creator',
      },
      update: {},
    });

    creatorId = creator.id;
  });

  afterAll(async () => {
    await prisma.creatorProfile.deleteMany({ where: { handle: HANDLE } });
    await prisma.stellarWallet.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.deleteMany({ where: { id: USER_ID } });
    await prisma.$disconnect();
  });

  it('rejects request with missing signature headers', async () => {
    const res = await supertest(app)
      .put(`/api/v1/creators/${creatorId}/profile`)
      .send({ displayName: 'Test' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects request with expired timestamp', async () => {
    const body = { displayName: 'Test' };
    const timestamp = (Date.now() - 10 * 60 * 1000).toString(); // 10 min ago
    const message = buildCanonicalMessage(body, timestamp);
    const signature = keypair.sign(message).toString('base64');

    const res = await supertest(app)
      .put(`/api/v1/creators/${creatorId}/profile`)
      .set('x-wallet-address', keypair.publicKey())
      .set('x-wallet-signature', signature)
      .set('x-timestamp', timestamp)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toContain('expired');
  });

  it('rejects request with tampered body', async () => {
    const originalBody = { displayName: 'Original' };
    const timestamp = Date.now().toString();
    const message = buildCanonicalMessage(originalBody, timestamp);
    const signature = keypair.sign(message).toString('base64');

    // Send different body than what was signed
    const tamperedBody = { displayName: 'Tampered' };

    const res = await supertest(app)
      .put(`/api/v1/creators/${creatorId}/profile`)
      .set('x-wallet-address', keypair.publicKey())
      .set('x-wallet-signature', signature)
      .set('x-timestamp', timestamp)
      .send(tamperedBody);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('tampered');
  });

  it('rejects request signed with wrong keypair', async () => {
    const wrongKeypair = Keypair.random();
    const body = { displayName: 'Test' };
    const timestamp = Date.now().toString();
    const message = buildCanonicalMessage(body, timestamp);
    const signature = wrongKeypair.sign(message).toString('base64');

    const res = await supertest(app)
      .put(`/api/v1/creators/${creatorId}/profile`)
      .set('x-wallet-address', keypair.publicKey()) // Correct address
      .set('x-wallet-signature', signature) // But wrong signature
      .set('x-timestamp', timestamp)
      .send(body);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('accepts valid signature and updates profile', async () => {
    const body = { displayName: 'Valid Update' };
    const timestamp = Date.now().toString();
    const message = buildCanonicalMessage(body, timestamp);
    const signature = keypair.sign(message).toString('base64');

    const res = await supertest(app)
      .put(`/api/v1/creators/${creatorId}/profile`)
      .set('x-wallet-address', keypair.publicKey())
      .set('x-wallet-signature', signature)
      .set('x-timestamp', timestamp)
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
  });

  it('rejects invalid Stellar address format', async () => {
    const body = { displayName: 'Test' };
    const timestamp = Date.now().toString();
    const message = buildCanonicalMessage(body, timestamp);
    const signature = keypair.sign(message).toString('base64');

    const res = await supertest(app)
      .put(`/api/v1/creators/${creatorId}/profile`)
      .set('x-wallet-address', 'INVALID_ADDRESS')
      .set('x-wallet-signature', signature)
      .set('x-timestamp', timestamp)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});
