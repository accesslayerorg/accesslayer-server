import { logger } from '../utils/logger.utils';
import { envConfig } from '../config';
import { sorobanRpcCircuitBreaker } from '../utils/circuit-breaker.utils';
import { RpcPool, parseRpcUrls } from './rpc-pool';

async function defaultPostJson(url: string, body: unknown): Promise<unknown> {
   const controller = new AbortController();
   const timeout = setTimeout(
      () => controller.abort(),
      envConfig.DB_QUERY_TIMEOUT_MS
   );

   try {
      const response = await fetch(url, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify(body),
         signal: controller.signal,
      });

      if (!response.ok) {
         throw new SorobanRpcHttpError(
            response.status,
            response.statusText || 'HTTP error'
         );
      }

      return (await response.json()) as unknown;
   } finally {
      clearTimeout(timeout);
   }
}

export type SorobanPostJson = (url: string, body: unknown) => Promise<unknown>;
export const defaultSorobanTransport: SorobanPostJson = defaultPostJson;

export class SorobanRpcHttpError extends Error {
   constructor(
      public readonly status: number,
      public readonly statusText: string
   ) {
      super(`Soroban RPC HTTP ${status}: ${statusText}`);
      this.name = 'SorobanRpcHttpError';
   }
}

export class SorobanRpcMethodError extends Error {
   constructor(
      public readonly code: number,
      message: string
   ) {
      super(`Soroban RPC error ${code}: ${message}`);
      this.name = 'SorobanRpcMethodError';
   }
}

export interface SendTransactionResult {
   hash?: string;
   status: string;
   errorResultXdr?: string;
   latestLedger?: number;
}

export interface GetTransactionResult {
   status: 'SUCCESS' | 'NOT_FOUND' | 'FAILED';
   latestLedger?: number;
   ledger?: number;
   resultXdr?: string;
}

interface JsonRpcEnvelope {
   result?: unknown;
   error?: { code: number; message: string };
}

let rpcPool: RpcPool | null = null;

function getRpcPool(): RpcPool | null {
   const urls = parseRpcUrls(
      envConfig.SOROBAN_RPC_URLS || envConfig.STELLAR_SOROBAN_RPC_URL
   );
   if (urls.length <= 1) return null;
   if (!rpcPool) {
      rpcPool = new RpcPool({
         endpoints: urls,
         probeIntervalMs: envConfig.RPC_POOL_PROBE_INTERVAL_MS,
         cooldownMs: envConfig.RPC_POOL_COOLDOWN_MS,
         maxLedgerLag: envConfig.RPC_POOL_MAX_LEDGER_LAG,
         errorRateThreshold: envConfig.RPC_POOL_ERROR_RATE_THRESHOLD,
         minSamplesForErrorRate: envConfig.RPC_POOL_MIN_SAMPLES_FOR_ERROR_RATE,
         hedgeDelayMs: envConfig.RPC_POOL_HEDGE_DELAY_MS,
      });
      rpcPool.start();
   }
   return rpcPool;
}

export function getSorobanRpcPool(): RpcPool | null {
   return getRpcPool();
}

export function stopSorobanRpcPool(): void {
   rpcPool?.stop();
   rpcPool = null;
}

async function callRpc<T>(
   method: string,
   params: unknown,
   postJson: SorobanPostJson
): Promise<T> {
   const pool = postJson === defaultPostJson ? getRpcPool() : null;
   if (pool) {
      return pool.callRpc<T>(method, params);
   }

   if (envConfig.MODE === 'test' && process.env.ENABLE_SOROBAN_CIRCUIT_BREAKER !== '1') {
      const url = envConfig.STELLAR_SOROBAN_RPC_URL;
      const body = { jsonrpc: '2.0', id: '1', method, params };

      let envelope: unknown;
      try {
         envelope = await postJson(url, body);
      } catch (error) {
         logger.warn(
            { method, error: (error as Error).message },
            'Soroban RPC request failed'
         );
         throw error;
      }

      const { result, error } = (envelope ?? {}) as JsonRpcEnvelope;
      if (error) {
         throw new SorobanRpcMethodError(error.code, error.message);
      }

      return result as T;
   }

   return sorobanRpcCircuitBreaker.execute(async () => {
      const url = envConfig.STELLAR_SOROBAN_RPC_URL;
      const body = { jsonrpc: '2.0', id: '1', method, params };

      let envelope: unknown;
      try {
         envelope = await postJson(url, body);
      } catch (error) {
         logger.warn(
            { method, error: (error as Error).message },
            'Soroban RPC request failed'
         );
         throw error;
      }

      const { result, error } = (envelope ?? {}) as JsonRpcEnvelope;
      if (error) {
         throw new SorobanRpcMethodError(error.code, error.message);
      }

      return result as T;
   });
}

export async function sendTransaction(
   transactionXdr: string,
   postJson: SorobanPostJson = defaultPostJson
): Promise<SendTransactionResult> {
   const pool = postJson === defaultPostJson ? getRpcPool() : null;
   if (pool) {
      const result = await pool.sendTransaction(transactionXdr);
      logger.debug({ tx_hash: result.hash, status: result.status }, 'Soroban sendTransaction response');
      return result;
   }

   const result = await callRpc<SendTransactionResult>(
      'sendTransaction',
      { transaction: transactionXdr },
      postJson
   );

   logger.debug(
      {
         tx_hash: result.hash,
         status: result.status,
      },
      'Soroban sendTransaction response'
   );

   return result;
}

export async function getTransaction(
   hash: string,
   postJson: SorobanPostJson = defaultPostJson
): Promise<GetTransactionResult> {
   return callRpc<GetTransactionResult>('getTransaction', { hash }, postJson);
}

export async function getHealth(
   postJson: SorobanPostJson = defaultPostJson
): Promise<{ status?: string }> {
   return callRpc<{ status?: string }>('getHealth', {}, postJson);
}

export async function getLatestLedger(
   postJson: SorobanPostJson = defaultPostJson
): Promise<{ sequence?: number }> {
   return callRpc<{ sequence?: number }>('getLatestLedger', {}, postJson);
}
