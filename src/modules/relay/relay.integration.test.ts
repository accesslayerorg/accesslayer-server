import express from 'express';
import request from 'supertest';
import {
   Account,
   Keypair,
   Networks,
   Operation,
   TransactionBuilder,
} from '@stellar/stellar-base';
import relayRouter from './relay.routes';
import { horizonGet } from '../../clients/horizon.client';
import { submitContractCall } from '../contracts/contract.service';
import { getRedis } from '../../utils/redis.utils';

jest.mock('../../clients/horizon.client', () => ({ horizonGet: jest.fn() }));
jest.mock('../contracts/contract.service', () => ({
   submitContractCall: jest.fn(),
}));
jest.mock('../../utils/redis.utils', () => ({ getRedis: jest.fn() }));

const walletKey = Keypair.random();
const wallet = walletKey.publicKey();
const other = Keypair.random();
const app = express();
app.use(express.json());
app.use('/relay', relayRouter);
const entries = new Map<string, { value: string; expires: number }>();
const rates = new Map<string, number[]>();
let now: number;
function read(key: string): string | null {
   const item = entries.get(key);
   if (!item || item.expires <= now) {
      entries.delete(key);
      return null;
   }
   return item.value;
}
const redis = {
   get: jest.fn(async (key: string) => read(key)),
   set: jest.fn(
      async (
         key: string,
         value: string,
         _ex: string,
         seconds: number,
         nx?: string
      ) => {
         if (nx && read(key) !== null) return null;
         entries.set(key, { value, expires: now + Number(seconds) * 1000 });
         return 'OK';
      }
   ),
   // In-memory test double models Redis's atomic rate/compare-and-set behavior.
   eval: jest.fn(
      async (
         _script: string,
         _count: number,
         key: string,
         ...args: string[]
      ) => {
         if (key.startsWith('relay:rate:')) {
            const recent = (rates.get(key) ?? []).filter(
               t => t > Number(args[0]) - Number(args[1])
            );
            if (recent.length >= Number(args[2])) return 0;
            recent.push(Number(args[0]));
            rates.set(key, recent);
            return 1;
         }
         if (read(key) !== args[0]) return 0;
         entries.set(key, {
            value: args[1],
            expires: now + Number(args[2]) * 1000,
         });
         return 1;
      }
   ),
};
function payload(key = walletKey, sequence = '9') {
   const tx = new TransactionBuilder(new Account(key.publicKey(), sequence), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
   })
      .addOperation(
         Operation.manageData({ name: 'relay-test', value: 'value' })
      )
      .setTimeout(300)
      .build();
   return {
      wallet: key.publicKey(),
      nonce: tx.sequence,
      signature: key.sign(tx.hash()).toString('base64'),
      tx_params: tx.toXDR(),
   };
}
async function reserve() {
   const res = await request(app).get(`/relay/nonce/${wallet}`);
   expect(res.status).toBe(200);
   return res;
}
beforeEach(() => {
   jest.clearAllMocks();
   entries.clear();
   rates.clear();
   now = 1_792_756_800_000;
   jest.spyOn(Date, 'now').mockImplementation(() => now);
   jest.mocked(getRedis).mockReturnValue(redis as any);
   jest.mocked(horizonGet).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sequence: '9' }),
   } as Response);
   jest.mocked(submitContractCall).mockResolvedValue({
      status: 'CONFIRMED',
      txHash: 'confirmed-hash',
      ledger: 10,
      attempts: 1,
   });
});
afterEach(() => jest.restoreAllMocks());

it('reserves the next chain sequence as a decimal string with a five-minute TTL', async () => {
   const res = await reserve();
   expect(res.body).toEqual({ wallet, nonce: '10' });
   expect(redis.set).toHaveBeenCalledWith(
      `relay:nonce:${wallet}`,
      '10',
      'EX',
      300,
      'NX'
   );
   await reserve();
   expect(horizonGet).toHaveBeenCalledTimes(1);
});
it('frees expired reservations and reads the latest sequence', async () => {
   await reserve();
   now += 300_001;
   jest.mocked(horizonGet).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sequence: '10' }),
   } as Response);
   expect((await reserve()).body.nonce).toBe('11');
});
it('preserves large sequence numbers without Number precision loss', async () => {
   jest.mocked(horizonGet).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sequence: '9007199254740993' }),
   } as Response);
   expect((await reserve()).body.nonce).toBe('9007199254740994');
});
it('rejects expired submissions before invoking the contract service', async () => {
   const body = payload();
   await reserve();
   now += 300_001;
   expect((await request(app).post('/relay/submit').send(body)).status).toBe(
      409
   );
   expect(submitContractCall).not.toHaveBeenCalled();
});
it('verifies and attaches a detached signature before submitting', async () => {
   await reserve();
   const body = payload();
   const res = await request(app).post('/relay/submit').send(body);
   expect(res.status).toBe(200);
   expect(res.body).toEqual({ tx_hash: 'confirmed-hash' });
   const input = jest.mocked(submitContractCall).mock.calls[0][0];
   expect(input.operation).toBe('relay');
   expect(input.submitterWallet).toBe(wallet);
   const envelope = TransactionBuilder.fromXDR(
      input.transactionXdr,
      Networks.TESTNET
   );
   expect(
      envelope.signatures.some(s =>
         walletKey.verify(envelope.hash(), s.signature())
      )
   ).toBe(true);
});
it('rejects a forged signature and a payload changed after signing', async () => {
   await reserve();
   const body = payload();
   body.signature = other.sign(Buffer.from('forged')).toString('base64');
   expect((await request(app).post('/relay/submit').send(body)).status).toBe(
      401
   );
   expect(submitContractCall).not.toHaveBeenCalled();
});
it('rejects mismatched wallet and sequence', async () => {
   await reserve();
   expect(
      (
         await request(app)
            .post('/relay/submit')
            .send({ ...payload(), nonce: '11' })
      ).status
   ).toBe(400);
   expect(
      (
         await request(app)
            .post('/relay/submit')
            .send({ ...payload(), wallet: other.publicKey() })
      ).status
   ).toBe(400);
   expect(submitContractCall).not.toHaveBeenCalled();
});
it('allows only one concurrent submission and rejects replay', async () => {
   await reserve();
   const body = payload();
   const responses = await Promise.all([
      request(app).post('/relay/submit').send(body),
      request(app).post('/relay/submit').send(body),
   ]);
   expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
   expect(submitContractCall).toHaveBeenCalledTimes(1);
   expect((await request(app).post('/relay/submit').send(body)).status).toBe(
      409
   );
});
it('keeps a failed or uncertain submission claimed', async () => {
   await reserve();
   jest.mocked(submitContractCall).mockResolvedValue({
      status: 'FAILED',
      txHash: 'pending-hash',
      errorKind: 'transient',
      lastError: 'private rpc data',
      attempts: 1,
   });
   const res = await request(app).post('/relay/submit').send(payload());
   expect(res.status).toBe(502);
   expect(res.body).toEqual({
      error: 'Relay transaction failed',
      details: { tx_hash: 'pending-hash', error_kind: 'transient' },
   });
   expect(
      (await request(app).post('/relay/submit').send(payload())).status
   ).toBe(409);
   expect((await request(app).get(`/relay/nonce/${wallet}`)).status).toBe(409);
});
it('reserves a new nonce only after the previous sequence advances on-chain', async () => {
   await reserve();
   await request(app).post('/relay/submit').send(payload());
   expect((await request(app).get(`/relay/nonce/${wallet}`)).status).toBe(409);
   jest.mocked(horizonGet).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sequence: '10' }),
   } as Response);
   expect((await reserve()).body.nonce).toBe('11');
});
it('limits both endpoints together to ten requests per wallet per rolling minute', async () => {
   await reserve();
   for (let i = 0; i < 9; i++)
      expect(
         (await request(app).post('/relay/submit').send(payload())).status
      ).not.toBe(429);
   const denied = await request(app).post('/relay/submit').send(payload());
   expect(denied.status).toBe(429);
   expect(denied.headers['retry-after']).toBe('60');
   expect((await request(app).get(`/relay/nonce/${wallet}`)).status).toBe(429);
   now += 60_001;
   expect((await request(app).get(`/relay/nonce/${wallet}`)).status).not.toBe(
      429
   );
});
it('fails closed when Redis is unavailable', async () => {
   jest.mocked(getRedis).mockReturnValue(null);
   expect((await request(app).get(`/relay/nonce/${wallet}`)).status).toBe(503);
   expect(
      (await request(app).post('/relay/submit').send(payload())).status
   ).toBe(503);
   expect(submitContractCall).not.toHaveBeenCalled();
});
it('rejects malformed input, invalid checksums, and invalid XDR', async () => {
   expect(
      (await request(app).get(`/relay/nonce/G${'A'.repeat(55)}`)).status
   ).toBe(400);
   expect((await request(app).post('/relay/submit').send({})).status).toBe(400);
   expect(
      (
         await request(app)
            .post('/relay/submit')
            .send({ ...payload(), tx_params: 'invalid' })
      ).status
   ).toBe(400);
   expect(submitContractCall).not.toHaveBeenCalled();
});
it('accepts a sponsored fee-bump without invalidating the sponsor signature', async () => {
   await reserve();
   const inner = new TransactionBuilder(new Account(wallet, '9'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
   })
      .addOperation(
         Operation.manageData({ name: 'relay-test', value: 'value' })
      )
      .setTimeout(300)
      .build();
   const signature = walletKey.sign(inner.hash()).toString('base64');
   inner.sign(walletKey);
   const envelope = TransactionBuilder.buildFeeBumpTransaction(
      other,
      '100',
      inner,
      Networks.TESTNET
   );
   envelope.sign(other);
   const original = envelope.toXDR();
   const res = await request(app)
      .post('/relay/submit')
      .send({ wallet, nonce: '10', signature, tx_params: original });
   expect(res.status).toBe(200);
   expect(jest.mocked(submitContractCall).mock.calls[0][0].transactionXdr).toBe(
      original
   );
});
it('rejects fee-bumps missing the embedded inner signature', async () => {
   await reserve();
   const body = payload();
   const inner = TransactionBuilder.fromXDR(body.tx_params, Networks.TESTNET);
   if ('innerTransaction' in inner)
      throw new Error('Expected standard transaction');
   const envelope = TransactionBuilder.buildFeeBumpTransaction(
      other,
      '100',
      inner,
      Networks.TESTNET
   );
   envelope.sign(other);
   expect(
      (
         await request(app)
            .post('/relay/submit')
            .send({ ...body, tx_params: envelope.toXDR() })
      ).status
   ).toBe(400);
   expect(submitContractCall).not.toHaveBeenCalled();
});
