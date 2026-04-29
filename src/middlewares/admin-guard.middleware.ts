import { Request, Response, NextFunction } from 'express';

export interface AdminRequest extends Request {
  adminId?: string;
}

export function adminGuard(req: AdminRequest, res: Response, next: NextFunction): void {
  const adminIdHeader = req.headers['x-admin-id'];
  const adminId =
    typeof adminIdHeader === 'string'
      ? adminIdHeader
      : Array.isArray(adminIdHeader)
        ? adminIdHeader[0]
        : undefined;

  if (!adminId) {
    res.status(403).json({
      type: 'FORBIDDEN',
      message: 'Admin authorization required.',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  req.adminId = adminId;
  next();
}
