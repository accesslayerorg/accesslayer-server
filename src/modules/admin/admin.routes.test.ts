import { adminGuard } from '../../middlewares/admin-guard.middleware';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { envConfig } from '../../config';

describe('adminGuard middleware', () => {
   let mockReq: Partial<Request>;
   let mockRes: Partial<Response>;
   let mockNext: NextFunction;

   beforeEach(() => {
      mockReq = { headers: {} };
      mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn() };
      mockNext = jest.fn();
   });

   it('should call next when valid admin ID is provided', () => {
      const token = jwt.sign({ sub: 'admin-123', role: 'admin' }, envConfig.JWT_SECRET);
      mockReq.headers = { authorization: `Bearer ${token}` };

      adminGuard(mockReq as any, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
   });

   it('should return 403 when admin ID is missing', () => {
      const token = jwt.sign({ sub: 'user-1', role: 'user' }, envConfig.JWT_SECRET);
      mockReq.headers = { authorization: `Bearer ${token}` };

      adminGuard(mockReq as any, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
         expect.objectContaining({
            success: false,
         })
      );
      expect(mockNext).not.toHaveBeenCalled();
   });

   it('should extract admin ID from token', () => {
      const token = jwt.sign({ sub: 'admin-456', role: 'admin' }, envConfig.JWT_SECRET);
      mockReq.headers = { authorization: `Bearer ${token}` };

      adminGuard(mockReq as any, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect((mockReq as any).adminId).toBe('admin-456');
   });

   it('should return 401 with unauthorized error when authorization fails', () => {
      adminGuard(mockReq as any, mockRes as Response, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith(
         expect.objectContaining({
            success: false,
         })
      );
   });
});
