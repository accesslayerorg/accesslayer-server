import { Response } from 'express';

export interface RateLimitResponse {
  type: 'RATE_LIMIT_EXCEEDED';
  message: string;
  retryAfterSeconds: number;
  timestamp: string;
}

export function sendRateLimitError(
  res: Response,
  retryAfterSeconds: number = 900
): void {
  const response: RateLimitResponse = {
    type: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests, please try again later.',
    retryAfterSeconds,
    timestamp: new Date().toISOString(),
  };

  res.status(429)
    .set('Retry-After', String(retryAfterSeconds))
    .json(response);
}
