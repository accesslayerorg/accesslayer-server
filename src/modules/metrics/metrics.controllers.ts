import { Request, Response } from 'express';
import { getQueueDepths } from '../../utils/queue-metrics.utils';
import { getCreatorReadMetrics } from '../../utils/creator-read-metrics.utils';
import { getCacheWarmMetrics } from '../../utils/cache-warm-metrics.utils';

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
