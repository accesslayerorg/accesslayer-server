// Opt in against a disposable PostgreSQL database; no fixtures outside this key are changed.
jest.unmock('@prisma/client');
jest.mock('../../utils/redis.utils', () => {
   const cache = new Map<string, unknown>();
   return {
      cacheGetJson: jest.fn(async (key: string) => cache.get(key) ?? null),
      cacheSetJson: jest.fn(async (key: string, value: unknown) => { cache.set(key, value); }),
      cacheInvalidate: jest.fn(async (...keys: string[]) => {
         for (const pattern of keys) {
            for (const key of [...cache.keys()]) {
               if (pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern) cache.delete(key);
            }
         }
      }),
   };
});
import express from 'express';
import request from 'supertest';
import { StrKey } from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import tipsRouter from '../tips/tips.routes';
import votingWeightRouter from './governance-voting-weight.routes';
import { processTipEvent } from '../indexer/tip-indexer.service';
import { processDelegationRevokedEvents, processVotingDelegationEvents } from './governance-delegation-indexer.service';

const suite = process.env.RUN_GOVERNANCE_TIPS_INTEGRATION === '1' ? describe : describe.skip;
const keyId = 'governance-tips-integration-key';
const alias = 'governance-tips-alias';
const keyAddress = StrKey.encodeContract(Buffer.alloc(32, 93));
const delegatee = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 91));
const delegator = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 92));
const time = new Date('2026-11-21T12:00:00Z');
const app = express();
app.use('/keys', tipsRouter);
app.use('/governance', votingWeightRouter);

async function clean() {
   await prisma.keyOwnership.deleteMany({ where: { creatorId: keyId } });
   await prisma.voteDelegation.deleteMany({ where: { keyId } });
   await prisma.voteDelegationHistory.deleteMany({ where: { keyId } });
   await prisma.keyTip.deleteMany({ where: { keyId } });
   await prisma.keyTipTotal.deleteMany({ where: { keyId } });
   await prisma.activity.deleteMany({ where: { creatorId: keyId } });
   await prisma.registeredKey.deleteMany({ where: { id: keyId } });
}

suite('voting weight and tip leaderboard database + HTTP', () => {
   beforeAll(async () => {
      await clean();
      await prisma.registeredKey.create({ data: { id: keyId, keyAddress, creatorWallet: delegatee, handle: alias } });
      await prisma.keyOwnership.createMany({ data: [
         { creatorId: keyId, ownerAddress: delegatee, balance: '3.25' },
         { creatorId: keyId, ownerAddress: delegator, balance: '4.5' },
      ] });
      await processVotingDelegationEvents([{
         eventType: 'VotingDelegated', keyId: alias, delegatorWallet: delegator, delegateeWallet: delegatee,
         ledger: 1, txHash: 'governance-tips-delegated', eventIndex: 0, occurredAt: time.toISOString(),
      }]);
   });
   afterAll(clean);

   it('combines holdings and delegated balances, then drops revoked weight from cache', async () => {
      const url = '/governance/voting-weight/' + delegatee + '/' + alias;
      const before = await request(app).get(url);
      expect(before.status).toBe(200);
      expect(before.body.data).toMatchObject({ own_weight: '3.25', delegated_weight: '4.5', total: '7.75' });
      await processDelegationRevokedEvents([{
         eventType: 'DelegationRevoked', keyId: alias, delegatorWallet: delegator,
         ledger: 2, txHash: 'governance-tips-revoked', eventIndex: 0,
         occurredAt: time.toISOString(),
      }]);
      const after = await request(app).get(url);
      expect(after.body.data).toMatchObject({ own_weight: '3.25', delegated_weight: '0', total: '3.25', delegators: [] });
   });

   it('ranks public/anonymous tip groups and invalidates cached ranking after a new tip', async () => {
      const tip = (txHash: string, amount: string, anonymous: boolean) => ({
         eventType: 'TipSent', keyId: alias, tipper: delegator, amount, anonymous,
         ledger: 3, txHash, eventIndex: 0, tippedAt: time.toISOString(),
      });
      await processTipEvent(tip('governance-tips-public', '10000000', false));
      const url = '/keys/' + alias + '/tips/leaderboard';
      const before = await request(app).get(url);
      expect(before.body.data[0]).toMatchObject({ rank: 1, total_tipped: '1.0000000', tip_count: 1, anonymous: false });
      const hidden = tip('governance-tips-hidden', '50000000', true);
      await processTipEvent(hidden);
      await processTipEvent(hidden);
      const after = await request(app).get(url);
      expect(after.status).toBe(200);
      expect(after.body.data).toHaveLength(2);
      expect(after.body.data[0]).toEqual({ rank: 1, wallet: null, total_tipped: '5.0000000', tip_count: 1, anonymous: true });
      expect(JSON.stringify(after.body.data)).not.toContain(delegator);
      expect(await prisma.keyTip.count({ where: { keyId } })).toBe(2);
      const history = await request(app).get('/keys/' + alias + '/tips');
      expect(history.body.data.data.find((row: { anonymous: boolean }) => row.anonymous).tipper).toBeNull();
   });
});
