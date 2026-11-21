import { Request, Response } from 'express';
import { getQueueDepths } from '../../utils/queue-metrics.utils';
import { getCreatorReadMetrics } from '../../utils/creator-read-metrics.utils';
import { getCacheWarmMetrics } from '../../utils/cache-warm-metrics.utils';
import { getOrderKeeperMetrics } from '../../utils/order-keeper-metrics.utils';

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

   res
      .status(200)
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(`${body}\n`);
};
