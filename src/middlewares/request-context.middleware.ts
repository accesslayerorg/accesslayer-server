import { Request, Response, NextFunction } from 'express';
import { requestContextStorage } from '../utils/als.utils';

export const requestContextMiddleware = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const context = {
    path: req.originalUrl || req.url,
    method: req.method,
    requestId: req.requestId as string | undefined,
  };

  requestContextStorage.run(context, () => {
    next();
  });
};
