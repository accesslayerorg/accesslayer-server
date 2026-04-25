import { Request, Response } from 'express';
import { getQueueDepths } from '../../utils/queue-metrics.utils';

export const queueMetrics = (_: Request, res: Response): void => {
  const queues = getQueueDepths();
  res.status(200).json({
    timestamp: new Date().toISOString(),
    queues,
  });
};
