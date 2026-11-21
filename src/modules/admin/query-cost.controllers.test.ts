import { httpResetQueryCost } from './query-cost.controllers';

const mockDel = jest.fn();

jest.mock('../../utils/redis.utils', () => ({
   getRedis: jest.fn(() => ({ del: mockDel })),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

describe('httpResetQueryCost', () => {
   const next = jest.fn();

   function createRes(): any {
      const res: any = {};
      res.status = jest.fn().mockReturnValue(res);
      res.json = jest.fn().mockReturnValue(res);
      return res;
   }

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('clears the wallet-scoped Redis key and returns success', async () => {
      const req: any = { params: { walletAddress: 'GABC123' } };
      const res = createRes();

      await httpResetQueryCost(req, res, next);

      expect(mockDel).toHaveBeenCalledWith('qcost:wallet:GABC123');
      expect(res.json).toHaveBeenCalledWith(
         expect.objectContaining({
            success: true,
            data: expect.objectContaining({
               walletAddress: 'GABC123',
               status: 'reset',
            }),
         })
      );
   });

   it('rejects a missing walletAddress param', async () => {
      const req: any = { params: {} };
      const res = createRes();

      await httpResetQueryCost(req, res, next);

      expect(mockDel).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
   });
});
