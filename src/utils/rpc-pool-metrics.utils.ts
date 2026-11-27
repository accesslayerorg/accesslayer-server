export type RpcFailoverReason = 'lag' | 'error_rate' | 'connection_error' | 'hedge';

type RpcPoolMetricsState = {
   up: Map<string, number>;
   latencySeconds: Map<string, number | null>;
   failovers: Map<RpcFailoverReason, number>;
};

const state: RpcPoolMetricsState = {
   up: new Map(),
   latencySeconds: new Map(),
   failovers: new Map([
      ['lag', 0],
      ['error_rate', 0],
      ['connection_error', 0],
      ['hedge', 0],
   ]),
};

export function setRpcEndpointUp(endpoint: string, up: number): void {
   state.up.set(endpoint, up);
}

export function setRpcEndpointLatencySeconds(endpoint: string, value: number | null): void {
   state.latencySeconds.set(endpoint, value);
}

export function incRpcFailover(reason: RpcFailoverReason, by = 1): void {
   state.failovers.set(reason, (state.failovers.get(reason) ?? 0) + by);
}

export function resetRpcPoolMetrics(): void {
   state.up.clear();
   state.latencySeconds.clear();
   state.failovers.set('lag', 0);
   state.failovers.set('error_rate', 0);
   state.failovers.set('connection_error', 0);
   state.failovers.set('hedge', 0);
}

export function getRpcPoolMetrics() {
   return {
      rpc_endpoint_up: [...state.up.entries()]
         .sort(([a], [b]) => a.localeCompare(b))
         .map(([endpoint, value]) => ({ labels: { endpoint }, value })),
      rpc_endpoint_latency_seconds: [...state.latencySeconds.entries()]
         .sort(([a], [b]) => a.localeCompare(b))
         .map(([endpoint, value]) => ({ labels: { endpoint }, value })),
      rpc_failovers_total: [...state.failovers.entries()].map(([reason, value]) => ({
         labels: { reason },
         value,
      })),
   };
}

export function toPrometheusMetrics(): string {
   const metrics = getRpcPoolMetrics();
   const lines: string[] = [
      '# HELP rpc_endpoint_up Whether an RPC endpoint is currently selectable (1) or not (0).',
      '# TYPE rpc_endpoint_up gauge',
      ...metrics.rpc_endpoint_up.map(
         s => `rpc_endpoint_up{endpoint="${s.labels.endpoint}"} ${s.value}`
      ),
      '# HELP rpc_endpoint_latency_seconds Last observed RPC endpoint latency in seconds.',
      '# TYPE rpc_endpoint_latency_seconds gauge',
      ...metrics.rpc_endpoint_latency_seconds
         .filter(s => s.value != null)
         .map(
            s =>
               `rpc_endpoint_latency_seconds{endpoint="${s.labels.endpoint}"} ${s.value}`
         ),
      '# HELP rpc_failovers_total Number of RPC failover/ejection/hedge events by reason.',
      '# TYPE rpc_failovers_total counter',
      ...metrics.rpc_failovers_total.map(
         s => `rpc_failovers_total{reason="${s.labels.reason}"} ${s.value}`
      ),
   ];
   return `${lines.join('\n')}\n`;
}
