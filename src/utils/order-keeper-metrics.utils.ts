let fills = 0;
let skips = 0;

export function recordKeeperFill(): void {
   fills += 1;
}

export function recordKeeperSkipped(): void {
   skips += 1;
}

export interface OrderKeeperMetricsSnapshot {
   keeper_fills_total: {
      type: 'counter';
      samples: Array<{ labels: Record<string, never>; value: number }>;
   };
   keeper_skipped_total: {
      type: 'counter';
      samples: Array<{ labels: Record<string, never>; value: number }>;
   };
}

export function getOrderKeeperMetrics(): OrderKeeperMetricsSnapshot {
   return {
      keeper_fills_total: {
         type: 'counter',
         samples: [{ labels: {}, value: fills }],
      },
      keeper_skipped_total: {
         type: 'counter',
         samples: [{ labels: {}, value: skips }],
      },
   };
}

export function resetOrderKeeperMetrics(): void {
   fills = 0;
   skips = 0;
}
