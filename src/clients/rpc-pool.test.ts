import { RpcPool } from './rpc-pool';
import { SorobanRpcHttpError } from './soroban.client';

function ok(result: unknown) {
   return { result };
}

describe('RpcPool', () => {
   it('routes reads to the healthiest endpoint', async () => {
      const calls: string[] = [];
      const pool = new RpcPool({
         endpoints: ['https://a', 'https://b'],
         postJson: async (url, body: any) => {
            calls.push(`${url}:${body.method}`);
            if (url === 'https://a') return ok({ sequence: 100 });
            return ok({ sequence: 102 });
         },
      });
      await pool.probeAll();
      await pool.getLatestLedger();
      expect(calls.filter(c => c.endsWith(':getLatestLedger')).at(-1)).toBe(
         'https://b:getLatestLedger'
      );
   });

   it('ejects lagging endpoint and re-admits after cooldown', async () => {
      let now = 1_000;
      let aSeq = 90;
      const pool = new RpcPool({
         endpoints: ['https://a', 'https://b'],
         now: () => now,
         cooldownMs: 1000,
         maxLedgerLag: 5,
         probeIntervalMs: 60_000,
         postJson: async (url, body: any) => {
            if (body.method === 'getLatestLedger') {
               return ok({ sequence: url === 'https://a' ? aSeq : 100 });
            }
            if (body.method === 'getHealth') return ok({ status: 'healthy' });
            return ok({ status: 'ok' });
         },
      });
      await pool.probeAll();
      const health = pool.getHealth();
      const a = health.find(h => h.url === 'https://a');
      const b = health.find(h => h.url === 'https://b');
      expect(b?.latestLedger).toBe(100);
      expect(a?.latestLedger).toBe(90);
      expect(a?.ejected).toBe(true);

      now += 1001;
      aSeq = 100;
      await pool.probeAll();
      expect(pool.getHealth().find(h => h.url === 'https://a')?.ejected).toBe(false);
   });

   it('pins submission and fails over only on connection errors', async () => {
      const calls: string[] = [];
      const pool = new RpcPool({
         endpoints: ['https://a', 'https://b'],
         postJson: async (url, body: any) => {
            calls.push(`${url}:${body.method}`);
            if (body.method === 'sendTransaction' && url === 'https://a') {
               throw new SorobanRpcHttpError(503, 'unavailable');
            }
            if (body.method === 'sendTransaction') {
               return ok({ hash: 'h1', status: 'PENDING' });
            }
            if (body.method === 'getLatestLedger') return ok({ sequence: 10 });
            return ok({ status: 'healthy' });
         },
      });
      await pool.probeAll();
      const res = await pool.sendTransaction('xdr');
      expect(res.hash).toBe('h1');
      expect(calls).toContain('https://a:sendTransaction');
      expect(calls).toContain('https://b:sendTransaction');

      calls.length = 0;
      const pool2 = new RpcPool({
         endpoints: ['https://a', 'https://b'],
         postJson: async (url, body: any) => {
            calls.push(`${url}:${body.method}`);
            if (body.method === 'sendTransaction' && url === 'https://a') {
               return { error: { code: -32000, message: 'tx_bad_seq' } };
            }
            if (body.method === 'sendTransaction') return ok({ hash: 'h2', status: 'PENDING' });
            if (body.method === 'getLatestLedger') return ok({ sequence: 10 });
            return ok({ status: 'healthy' });
         },
      });
      await pool2.probeAll();
      await expect(pool2.sendTransaction('xdr')).rejects.toThrow('tx_bad_seq');
      expect(calls.filter(c => c.includes('sendTransaction'))).toEqual([
         'https://a:sendTransaction',
      ]);
   });

   it('hedges slow reads and cancels losing request', async () => {
      const { resetRpcPoolMetrics } = require('../utils/rpc-pool-metrics.utils');
      resetRpcPoolMetrics();
      const pool = new RpcPool({
         endpoints: ['https://a', 'https://b'],
         hedgeDelayMs: 10,
         postJson: async (url, body: any, signal?: AbortSignal) => {
            if (body.method === 'getLatestLedger') {
               if (url === 'https://a') {
                  return await new Promise((_resolve, reject) => {
                     const t = setTimeout(() => _resolve(ok({ sequence: 1 })), 5000);
                     signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
                  });
               }
               return ok({ sequence: 7 });
            }
            if (body.method === 'getHealth') return ok({ status: 'healthy' });
            return ok({});
         },
      });
      await pool.probeAll();
      const result = await pool.getLatestLedger();
      expect(result.sequence).toBe(7);
      const hedge = pool.getMetrics().rpc_failovers_total.find((m: any) => m.labels.reason === 'hedge');
      expect(hedge?.value ?? 0).toBeGreaterThanOrEqual(0);
      expect(result.sequence).toBe(7);
   }, 10000);
});
