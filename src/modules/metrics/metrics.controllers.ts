import { Request, Response } from 'express';
import { getQueueDepths } from '../../utils/queue-metrics.utils';
import { getCreatorReadMetrics } from '../../utils/creator-read-metrics.utils';
import { getCacheWarmMetrics } from '../../utils/cache-warm-metrics.utils';
import { getOrderKeeperMetrics } from '../../utils/order-keeper-metrics.utils';
import { getRetentionMetrics } from '../../utils/retention-metrics.utils';
import { getPushMetrics } from '../../utils/push-metrics.utils';
import { toPrometheusMetrics as rpcPoolPrometheus } from '../../utils/rpc-pool-metrics.utils';

export const queueMetrics = (_: Request, res: Response): void => {
   const queues = getQueueDepths();
   res.status(200).json({
      timestamp: new Date().toISOString(),
      queues,
   });
};

export const creatorReadMetrics = (_: Request, res: Response): void => {
   const creatorReads = getCreatorReadMetrics();

   res.status(200).json({
      timestamp: new Date().toISOString(),
      creatorReads,
   });
};

export const cacheWarmMetrics = (_: Request, res: Response): void => {
   res.status(200).json({
      timestamp: new Date().toISOString(),
      ...getCacheWarmMetrics(),
   });
};

export const orderKeeperMetrics = (_: Request, res: Response): void => {
   const metrics = getOrderKeeperMetrics();
   const body = [
      '# HELP keeper_fills_total Number of limit orders successfully filled by the keeper.',
      '# TYPE keeper_fills_total counter',
      `keeper_fills_total ${metrics.keeper_fills_total.samples[0].value}`,
      '# HELP keeper_skipped_total Number of limit orders skipped by the keeper.',
      '# TYPE keeper_skipped_total counter',
      `keeper_skipped_total ${metrics.keeper_skipped_total.samples[0].value}`,
   ].join('\n');

   res.status(200)
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(`${body}\n`);
};

export const pushMetrics = (_: Request, res: Response): void => {
   res.status(200).json({
      timestamp: new Date().toISOString(),
      ...getPushMetrics(),
   });
};

export const retentionMetrics = (_: Request, res: Response): void => {
   const samples = getRetentionMetrics();
   const body = [
      '# HELP retention_rows_deleted_total Number of rows deleted by the retention worker.',
      '# TYPE retention_rows_deleted_total counter',
      ...samples.map(
         ({ table, value }) =>
            `retention_rows_deleted_total{table="${table.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"} ${value}`
      ),
   ].join('\n');

   res.status(200)
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(`${body}\n`);
};

export const rpcPoolMetrics = (_: Request, res: Response): void => {
   res.status(200)
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(rpcPoolPrometheus());
};
