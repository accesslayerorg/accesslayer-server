import { adminGuard } from '../../middlewares/admin-guard.middleware';
import { Request, Response, NextFunction } from 'express';

describe('adminGuard middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = { headers: {} };
    mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    mockNext = jest.fn();
  });

  it('should call next when valid admin ID is provided', () => {
    mockReq.headers = { 'x-admin-id': 'admin-123' };

    adminGuard(mockReq as any, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('should return 403 when admin ID is missing', () => {
    mockReq.headers = {};

    adminGuard(mockReq as any, mockRes as Response, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'FORBIDDEN',
        message: 'Admin authorization required.',
      })
    );
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should extract admin ID from array header', () => {
    mockReq.headers = { 'x-admin-id': ['admin-456'] };

    adminGuard(mockReq as any, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect((mockReq as any).adminId).toBe('admin-456');
  });

  it('should return 403 with timestamp when authorization fails', () => {
    adminGuard(mockReq as any, mockRes as Response, mockNext);

    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        timestamp: expect.any(String),
      })
    );
  });
});
