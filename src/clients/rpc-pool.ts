import { logger } from '../utils/logger.utils';
import { envConfig } from '../config';
import {
   SorobanRpcHttpError,
   SorobanRpcMethodError,
   type GetTransactionResult,
   type SendTransactionResult,
   type SorobanPostJson,
} from './soroban.client';
import {
   getRpcPoolMetrics,
   incRpcFailover,
   setRpcEndpointLatencySeconds,
   setRpcEndpointUp,
   type RpcFailoverReason,
} from '../utils/rpc-pool-metrics.utils';

export interface RpcPoolOptions {
   endpoints: string[];
   now?: () => number;
   postJson?: SorobanPostJson;
   probeIntervalMs?: number;
   cooldownMs?: number;
   maxLedgerLag?: number;
   errorRateThreshold?: number;
   minSamplesForErrorRate?: number;
   hedgeDelayMs?: number;
   hedgePercentileMultiplier?: number;
   requestTimeoutMs?: number;
}

export interface RpcPoolEndpointHealth {
   url: string;
   healthy: boolean;
   ejected: boolean;
   cooldownUntil: number | null;
   lastLatencyMs: number | null;
   latestLedger: number | null;
   errorCount: number;
   successCount: number;
}

interface EndpointState {
   url: string;
   healthy: boolean;
   ejected: boolean;
   cooldownUntil: number | null;
   lastLatencyMs: number | null;
   latestLedger: number | null;
   errorCount: number;
   successCount: number;
   latenciesMs: number[];
}

const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_LEDGER_LAG = 5;
const DEFAULT_ERROR_RATE_THRESHOLD = 0.5;
const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_HEDGE_DELAY_MS = 750;
const DEFAULT_PROBE_INTERVAL_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_LATENCY_SAMPLES = 50;

const normalize = (url: string) => url.trim().replace(/\/+$/, '');

function percentile(values: number[], p: number): number | null {
   if (values.length === 0) return null;
   const sorted = [...values].sort((a, b) => a - b);
   const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
   );
   return sorted[idx];
}

export class RpcPool {
   private readonly states: EndpointState[];
   private readonly now: () => number;
   private readonly postJson: SorobanPostJson;
   private readonly probeIntervalMs: number;
   private readonly cooldownMs: number;
   private readonly maxLedgerLag: number;
   private readonly errorRateThreshold: number;
   private readonly minSamplesForErrorRate: number;
   private readonly hedgeDelayMs: number;
   private readonly hedgePercentileMultiplier: number;
   private readonly requestTimeoutMs: number;
   private probeTimer: NodeJS.Timeout | null = null;
   private submissionPin: string | null = null;
   private refreshingCooldowns = false;

   constructor(options: RpcPoolOptions) {
      const endpoints = options.endpoints
         .map(normalize)
         .filter((v, i, a) => v.length > 0 && a.indexOf(v) === i);
      if (endpoints.length === 0) throw new Error('RpcPool requires at least one endpoint');
      this.now = options.now ?? (() => Date.now());
      this.postJson = options.postJson ?? this.defaultPostJson.bind(this);
      this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
      this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
      this.maxLedgerLag = options.maxLedgerLag ?? DEFAULT_MAX_LEDGER_LAG;
      this.errorRateThreshold = options.errorRateThreshold ?? DEFAULT_ERROR_RATE_THRESHOLD;
      this.minSamplesForErrorRate = options.minSamplesForErrorRate ?? DEFAULT_MIN_SAMPLES;
      this.hedgeDelayMs = options.hedgeDelayMs ?? DEFAULT_HEDGE_DELAY_MS;
      this.hedgePercentileMultiplier = options.hedgePercentileMultiplier ?? 1;
      this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      this.states = endpoints.map(url => ({
         url,
         healthy: true,
         ejected: false,
         cooldownUntil: null,
         lastLatencyMs: null,
         latestLedger: null,
         errorCount: 0,
         successCount: 0,
         latenciesMs: [],
      }));
      this.submissionPin = this.states[0].url;
      this.syncMetrics();
   }

   private async defaultPostJson(url: string, body: unknown): Promise<unknown> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
         const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
         });
         if (!response.ok) {
            throw new SorobanRpcHttpError(response.status, response.statusText || 'HTTP error');
         }
         return (await response.json()) as unknown;
      } finally {
         clearTimeout(timeout);
      }
   }

   start(): void {
      if (this.probeTimer) return;
      void this.probeAll().catch(err => logger.warn({ err }, 'RpcPool initial probe failed'));
      this.probeTimer = setInterval(() => {
         void this.probeAll().catch(err => logger.warn({ err }, 'RpcPool probe failed'));
      }, this.probeIntervalMs);
      this.probeTimer.unref?.();
   }

   stop(): void {
      if (this.probeTimer) clearInterval(this.probeTimer);
      this.probeTimer = null;
   }

   getHealth(): RpcPoolEndpointHealth[] {
      this.refreshCooldowns();
      return this.states.map(s => ({ ...s }));
   }

   getMetrics() {
      return getRpcPoolMetrics();
   }

   private syncMetrics(): void {
      for (const s of this.states) {
         setRpcEndpointUp(s.url, s.healthy && !s.ejected ? 1 : 0);
         setRpcEndpointLatencySeconds(
            s.url,
            s.lastLatencyMs == null ? null : s.lastLatencyMs / 1000
         );
      }
   }

   private maxKnownLedger(): number | null {
      const ledgers = this.states
         .map(s => s.latestLedger)
         .filter((v): v is number => typeof v === 'number');
      return ledgers.length ? Math.max(...ledgers) : null;
   }

   private refreshCooldowns(): void {
      if (this.refreshingCooldowns) return;
      this.refreshingCooldowns = true;
      try {
         const now = this.now();
         const maxLedger = this.maxKnownLedger();
         for (const s of this.states) {
            if (s.ejected && s.cooldownUntil && now >= s.cooldownUntil) {
               const lagging =
                  maxLedger != null && s.latestLedger != null && maxLedger - s.latestLedger > this.maxLedgerLag;
               const total = s.errorCount + s.successCount;
               const badRate = total >= this.minSamplesForErrorRate && s.errorCount / total > this.errorRateThreshold;
               if (!lagging && !badRate) {
                  s.ejected = false;
                  s.cooldownUntil = null;
                  s.healthy = true;
                  logger.info({ endpoint: s.url }, 'RpcPool endpoint re-admitted');
               } else {
                  s.cooldownUntil = now + this.cooldownMs;
               }
            }
         }
         if (!this.submissionPin || this.getState(this.submissionPin).ejected) {
            const healthy = this.states.filter(s => !s.ejected).sort((a, b) => b.successCount - a.successCount);
            this.submissionPin = healthy[0]?.url ?? this.states[0].url;
         }
         this.syncMetrics();
      } finally {
         this.refreshingCooldowns = false;
      }
   }

   private getState(url: string): EndpointState {
      const s = this.states.find(x => x.url === url);
      if (!s) throw new Error(`Unknown RPC endpoint: ${url}`);
      return s;
   }

   private recordSuccess(state: EndpointState, latencyMs: number, ledger?: number | null): void {
      state.successCount += 1;
      state.lastLatencyMs = latencyMs;
      state.latenciesMs.push(latencyMs);
      if (state.latenciesMs.length > MAX_LATENCY_SAMPLES) state.latenciesMs.shift();
      if (typeof ledger === 'number') state.latestLedger = ledger;
      state.healthy = true;
      this.evaluateEjection(state);
      this.syncMetrics();
   }

   private recordFailure(state: EndpointState, reason: RpcFailoverReason): void {
      state.errorCount += 1;
      state.healthy = false;
      incRpcFailover(reason);
      this.evaluateEjection(state);
      this.syncMetrics();
   }

   private evaluateEjection(state: EndpointState): void {
      const maxLedger = this.maxKnownLedger();
      const lagging =
         maxLedger != null && state.latestLedger != null && maxLedger - state.latestLedger > this.maxLedgerLag;
      const total = state.errorCount + state.successCount;
      const badRate = total >= this.minSamplesForErrorRate && state.errorCount / total > this.errorRateThreshold;
      if ((lagging || badRate) && !state.ejected) {
         state.ejected = true;
         state.cooldownUntil = this.now() + this.cooldownMs;
         state.healthy = false;
         incRpcFailover(lagging ? 'lag' : 'error_rate');
         logger.warn({ endpoint: state.url, lagging, badRate }, 'RpcPool endpoint ejected');
         if (this.submissionPin === state.url) {
            this.submissionPin = this.selectReadEndpoint()?.url ?? this.states[0].url;
         }
      }
   }

   async probeAll(): Promise<void> {
      const results = await Promise.all(this.states.map(async s => {
         const start = this.now();
         try {
            const health = await this.callRpcOnEndpoint<{ status?: string }>(s, 'getHealth', {});
            const latest = await this.callRpcOnEndpoint<{ sequence?: number }>(s, 'getLatestLedger', {});
            return { s, ok: true as const, latency: this.now() - start, health, latest };
         } catch (error) {
            return { s, ok: false as const, error };
         }
      }));
      for (const r of results) {
         if (r.ok) {
            this.recordSuccess(r.s, r.latency, typeof r.latest?.sequence === 'number' ? r.latest.sequence : null);
            if (r.health?.status && r.health.status !== 'healthy') r.s.healthy = false;
         } else {
            this.recordFailure(r.s, 'connection_error');
            logger.debug({ endpoint: r.s.url, err: r.error }, 'RpcPool endpoint probe failed');
         }
      }
      for (const s of this.states) this.evaluateEjection(s);
      this.refreshCooldowns();
   }

   private async callRpcOnEndpoint<T>(state: EndpointState, method: string, params: unknown): Promise<T> {
      const body = { jsonrpc: '2.0', id: '1', method, params };
      const envelope = (await this.postJson(state.url, body)) as {
         result?: T;
         error?: { code: number; message: string };
      };
      if (envelope?.error) throw new SorobanRpcMethodError(envelope.error.code, envelope.error.message);
      return envelope?.result as T;
   }

   selectReadEndpoint(): EndpointState | null {
      this.refreshCooldowns();
      const maxLedger = this.maxKnownLedger();
      const candidates = this.states.filter(s => !s.ejected);
      if (candidates.length === 0) return this.states[0] ?? null;
      return candidates
         .map(s => {
            const lag = maxLedger != null && s.latestLedger != null ? Math.max(0, maxLedger - s.latestLedger) : 0;
            const total = s.errorCount + s.successCount;
            const errorRate = total === 0 ? 0 : s.errorCount / total;
            const latency = s.lastLatencyMs ?? this.hedgeDelayMs;
            return { s, score: lag * 1000 + errorRate * 10_000 + latency };
         })
         .sort((a, b) => a.score - b.score)[0].s;
   }

   private getHedgeDelayMs(): number {
      const p95 = percentile(this.states.flatMap(s => s.latenciesMs), 95);
      if (p95 == null) return this.hedgeDelayMs;
      return Math.max(25, Math.min(this.hedgeDelayMs, Math.floor(p95 * this.hedgePercentileMultiplier)));
   }

   async callRpc<T>(method: string, params: unknown): Promise<T> {
      const primary = this.selectReadEndpoint();
      if (!primary) throw new Error('No RPC endpoints configured');
      const secondary = this.states.find(s => !s.ejected && s.url !== primary.url);
      if (!secondary) return this.callRpcWithTracking<T>(primary, method, params);

      return new Promise<T>((resolve, reject) => {
         let settled = false;
         let primaryFailed = false;
         let secondaryFailed = false;
         let secondaryStarted = false;
         let timer: NodeJS.Timeout | null = null;
         const maybeReject = (err: unknown) => {
            if (!settled && primaryFailed && secondaryFailed) {
               settled = true;
               if (timer) clearTimeout(timer);
               reject(err);
            }
         };
         const run = (state: EndpointState, isHedge: boolean) => {
            this.callRpcWithTracking<T>(state, method, params)
               .then(result => {
                  if (settled) return;
                  settled = true;
                  if (timer) clearTimeout(timer);
                  if (isHedge) incRpcFailover('hedge');
                  resolve(result);
               })
               .catch(err => {
                  if (state.url === primary.url) primaryFailed = true;
                  else secondaryFailed = true;
                  if (!secondaryStarted && state.url === primary.url) {
                     secondaryStarted = true;
                     if (timer) clearTimeout(timer);
                     run(secondary, true);
                     return;
                  }
                  maybeReject(err);
               });
         };
         run(primary, false);
         timer = setTimeout(() => {
            if (settled || secondaryStarted) return;
            secondaryStarted = true;
            run(secondary, true);
         }, this.getHedgeDelayMs());
      });
   }

   private async callRpcWithTracking<T>(state: EndpointState, method: string, params: unknown): Promise<T> {
      const start = this.now();
      try {
         const result = await this.callRpcOnEndpoint<T>(state, method, params);
         const latency = this.now() - start;
         const ledger =
            result && typeof result === 'object' && 'latestLedger' in (result as any)
               ? ((result as any).latestLedger as number | undefined)
               : result && typeof result === 'object' && 'sequence' in (result as any)
                 ? ((result as any).sequence as number | undefined)
                 : undefined;
         this.recordSuccess(state, latency, ledger ?? null);
         return result;
      } catch (error) {
         const connectionError =
            error instanceof SorobanRpcHttpError ||
            (error instanceof Error && /fetch|aborted|network|timeout|ECONN|ENOTFOUND/i.test(error.message));
         this.recordFailure(state, connectionError ? 'connection_error' : 'error_rate');
         throw error;
      }
   }

   async getLatestLedger(): Promise<{ sequence: number }> {
      return this.callRpc<{ sequence: number }>('getLatestLedger', {});
   }

   async getHealthSummary(): Promise<{ status: string }> {
      await this.probeAll();
      return { status: this.getHealth().some(h => h.healthy && !h.ejected) ? 'healthy' : 'unhealthy' };
   }

   async getTransaction(hash: string): Promise<GetTransactionResult> {
      return this.callRpc<GetTransactionResult>('getTransaction', { hash });
   }

   async sendTransaction(transactionXdr: string): Promise<SendTransactionResult> {
      this.refreshCooldowns();
      const primary = this.getState(this.submissionPin || this.selectReadEndpoint()?.url || this.states[0].url);
      const ordered = [
         primary,
         ...this.states.filter(s => s.url !== primary.url && !s.ejected),
         ...this.states.filter(s => s.url !== primary.url && s.ejected),
      ].filter((v, i, a) => a.indexOf(v) === i);

      let lastError: unknown;
      for (const state of ordered) {
         try {
            const result = await this.callRpcWithTracking<SendTransactionResult>(
               state,
               'sendTransaction',
               { transaction: transactionXdr }
            );
            this.submissionPin = state.url;
            return result;
         } catch (error) {
            lastError = error;
            const isConnectionError =
               error instanceof SorobanRpcHttpError ||
               (error instanceof Error && /fetch|aborted|network|timeout|ECONN|ENOTFOUND/i.test(error.message));
            if (!isConnectionError) throw error;
            logger.warn({ endpoint: state.url, err: error }, 'RpcPool submission connection error; failing over');
         }
      }
      throw lastError instanceof Error ? lastError : new Error('RPC submission failed');
   }
}

export function parseRpcUrls(value: string | undefined | null): string[] {
   if (!value) return [];
   return value
      .split(',')
      .map(normalize)
      .filter(v => v.length > 0);
}

export function createRpcPoolFromEnv(options: Partial<RpcPoolOptions> = {}): RpcPool {
   const urls = parseRpcUrls(envConfig.SOROBAN_RPC_URLS || envConfig.STELLAR_SOROBAN_RPC_URL);
   return new RpcPool({ ...options, endpoints: urls });
}
