jest.unmock('@prisma/client');

const mockCache = new Map<string, unknown>();
jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => mockCache.get(key) ?? null),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => { mockCache.set(key, value); }),
   cacheInvalidate: jest.fn(async (key: string) => { mockCache.delete(key); }),
}));

import { randomBytes, randomUUID } from 'crypto';
import express from 'express';
import supertest from 'supertest';
import { StrKey } from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import marketplaceRouter from './marketplace.routes';
import royaltyRouter from './royalty-enforcement.routes';
import concentrationRouter from '../concentration/concentration.routes';
import { processMarketplaceEvents } from '../indexer/marketplace-indexer.service';
import { onConcentrationBalanceChanged } from '../concentration/concentration.service';

const app = express();
app.use('/api/v1/marketplaces', marketplaceRouter);
app.use('/api/v1/keys', royaltyRouter);
app.use('/api/v1/keys', concentrationRouter);

const id = randomUUID();
const keyId = `concentration-${id}`;
const handle = `concentration-handle-${id}`;
const preKeyId = `pre-key-${id}`;
const preHandle = `pre-handle-${id}`;
const address = StrKey.encodeContract(randomBytes(32));
const reserve = StrKey.encodeEd25519PublicKey(randomBytes(32));
const wallets = [
   StrKey.encodeEd25519PublicKey(randomBytes(32)),
   StrKey.encodeEd25519PublicKey(randomBytes(32)),
];
const txHashes = Array.from({ length: 10 }, () => randomBytes(32).toString('hex'));
const event = (eventType: string, txIndex: number, ledger: number, payload: Record<string, unknown>) => ({
   eventType, txHash: txHashes[txIndex], eventIndex: 0, ledger,
   timestamp: '2026-11-21T12:00:00Z', ...payload,
});

beforeAll(async () => {
   await prisma.user.create({
      data: { id, email: `${id}@example.invalid`, passwordHash: 'fixture-only', firstName: 'Fixture', lastName: 'User' },
   });
   await prisma.creatorProfile.create({
      data: { id: keyId, handle, userId: id, displayName: 'Concentration fixture' },
   });
   await prisma.registeredKey.create({ data: { keyAddress: reserve, creatorWallet: wallets[0] } });
});

beforeEach(() => { mockCache.clear(); });

afterAll(async () => {
   await prisma.keyOwnership.deleteMany({ where: { creatorId: keyId } });
   await prisma.keyRoyaltyEnforcement.deleteMany({ where: { keyId: { in: [keyId, handle, preKeyId, preHandle] } } });
   await prisma.marketplaceRegistryEvent.deleteMany({ where: { txHash: { in: txHashes } } });
   await prisma.approvedMarketplace.deleteMany({ where: { address } });
   await prisma.registeredKey.deleteMany({ where: { keyAddress: reserve } });
   await prisma.creatorProfile.deleteMany({ where: { id: { in: [keyId, preKeyId] } } });
   await prisma.user.deleteMany({ where: { id } });
});

describe('marketplace and royalty event-to-HTTP reads against the database', () => {
   it('invalidates cached approvals on revocation and ignores replayed/stale approvals', async () => {
      const approval = event('marketplace_approved', 0, 10, { address });
      await processMarketplaceEvents([approval]);
      const first = await supertest(app).get('/api/v1/marketplaces');
      expect(first.status).toBe(200);
      expect(first.body.data).toContainEqual({ address, approvedAt: '2026-11-21T12:00:00.000Z' });

      await processMarketplaceEvents([event('marketplace_revoked', 1, 11, { address })]);
      await processMarketplaceEvents([approval]);
      await processMarketplaceEvents([event('marketplace_approved', 2, 9, { address })]);
      const result = await supertest(app).get('/api/v1/marketplaces');
      expect(result.body.data.some((item: { address: string }) => item.address === address)).toBe(false);
      expect(await prisma.marketplaceRegistryEvent.count({ where: { txHash: txHashes[0] } })).toBe(1);
   });

   it('serves the latest enforcement event and retains its lock flag on replay', async () => {
      const first = event('royalty_enforcement_set', 3, 12, { keyId: handle, royaltyEnforced: true, locked: true });
      await processMarketplaceEvents([first]);
      expect(await prisma.keyRoyaltyEnforcement.findUnique({ where: { keyId: handle } })).toBeNull();
      const byHandle = await supertest(app).get(`/api/v1/keys/${handle}/royalty-enforcement`);
      const byId = await supertest(app).get(`/api/v1/keys/${keyId}/royalty-enforcement`);
      expect(byHandle.body.data).toEqual({ keyId, royaltyEnforced: true, locked: true });
      expect(byId.body.data).toEqual(byHandle.body.data);
      await processMarketplaceEvents([
         event('royalty_enforcement_set', 4, 13, { keyId, royaltyEnforced: false, locked: true }),
         first,
      ]);
      const response = await supertest(app).get(`/api/v1/keys/${keyId}/royalty-enforcement`);
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ keyId, royaltyEnforced: false, locked: true });
   });
});

describe('registry identifier and chain ordering regressions', () => {
   it('keeps a previously unknown handle visible after registration and prefers newer canonical events', async () => {
      await processMarketplaceEvents([
         event('royalty_enforcement_set', 5, 20, { keyId: preHandle, royaltyEnforced: true, locked: false }),
      ]);
      await prisma.creatorProfile.create({
         data: { id: preKeyId, handle: preHandle, userId: id, displayName: 'Pre-registration fixture' },
      });
      const prior = await supertest(app).get(`/api/v1/keys/${preKeyId}/royalty-enforcement`);
      expect(prior.body.data).toEqual({ keyId: preKeyId, royaltyEnforced: true, locked: false });
      await processMarketplaceEvents([
         event('royalty_enforcement_set', 6, 21, { keyId: preHandle, royaltyEnforced: false, locked: true }),
      ]);
      const current = await supertest(app).get(`/api/v1/keys/${preKeyId}/royalty-enforcement`);
      expect(current.body.data).toEqual({ keyId: preKeyId, royaltyEnforced: false, locked: true });
   });

   it('does not restore a lower event index received late from the same transaction', async () => {
      const revoke = event('marketplace_revoked', 7, 30, { address, eventIndex: 1 });
      const staleApproval = { ...revoke, eventType: 'marketplace_approved', eventIndex: 0 };
      await processMarketplaceEvents([revoke, staleApproval]);
      const markets = await supertest(app).get('/api/v1/marketplaces');
      expect(markets.body.data.some((item: { address: string }) => item.address === address)).toBe(false);

      const latest = event('royalty_enforcement_set', 8, 31, {
         keyId, royaltyEnforced: true, locked: true, eventIndex: 1,
      });
      await processMarketplaceEvents([latest, { ...latest, eventIndex: 0, royaltyEnforced: false }]);
      const flags = await supertest(app).get(`/api/v1/keys/${keyId}/royalty-enforcement`);
      expect(flags.body.data).toEqual({ keyId, royaltyEnforced: true, locked: true });
   });
});

describe('concentration HTTP reads against indexed balances', () => {
   it('excludes contracts and the registered bonding-curve reserve by default', async () => {
      await prisma.keyOwnership.createMany({
         data: [
            ...wallets.map(ownerAddress => ({ creatorId: keyId, ownerAddress, balance: '100' })),
            { creatorId: keyId, ownerAddress: address, balance: '10000' },
            { creatorId: keyId, ownerAddress: reserve, balance: '20000' },
         ],
      });
      const response = await supertest(app).get(`/api/v1/keys/${keyId}/concentration`);
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ holderCount: 2, giniCoefficient: 0, top1Share: 0.5 });

      const inclusive = await supertest(app).get(`/api/v1/keys/${keyId}/concentration?includeContracts=true`);
      expect(inclusive.status).toBe(200);
      expect(inclusive.body.data.holderCount).toBe(4);
      expect(inclusive.body.data.top1Share).toBeCloseTo(20000 / 30200);

      await prisma.keyOwnership.deleteMany({ where: { creatorId: keyId } });
      await onConcentrationBalanceChanged(keyId);
      const empty = await supertest(app).get(`/api/v1/keys/${keyId}/concentration`);
      expect(empty.body.data).toMatchObject({ holderCount: 0, top1Share: 0, giniCoefficient: 0 });
   });

   it('returns clear validation and not-found responses', async () => {
      expect((await supertest(app).get(`/api/v1/keys/${keyId}/concentration?includeContracts=1`)).status).toBe(400);
      expect((await supertest(app).get('/api/v1/keys/unknown-fixture/concentration')).status).toBe(404);
      expect((await supertest(app).get('/api/v1/keys/unknown-fixture/royalty-enforcement')).status).toBe(404);
   });
});
