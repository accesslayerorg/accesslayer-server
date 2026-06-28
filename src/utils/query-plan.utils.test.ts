import { captureQueryPlan } from './query-plan.utils';
import { prisma } from './prisma.utils';
import { envConfig } from '../config';

jest.mock('./prisma.utils', () => ({
   prisma: {
      $queryRawUnsafe: jest.fn(),
   },
}));

const queryRawUnsafeMock = prisma.$queryRawUnsafe as unknown as jest.Mock;

describe('captureQueryPlan()', () => {
   const originalMode = envConfig.MODE;

   afterEach(() => {
      (envConfig as any).MODE = originalMode;
      jest.clearAllMocks();
   });

   describe('non-development environments', () => {
      it('returns null in production without touching the database', async () => {
         (envConfig as any).MODE = 'production';

         const result = await captureQueryPlan('SELECT * FROM "CreatorProfile"');

         expect(result).toBeNull();
         expect(queryRawUnsafeMock).not.toHaveBeenCalled();
      });

      it('returns null in test mode without touching the database', async () => {
         (envConfig as any).MODE = 'test';

         const result = await captureQueryPlan('SELECT * FROM "CreatorProfile"');

         expect(result).toBeNull();
         expect(queryRawUnsafeMock).not.toHaveBeenCalled();
      });
   });

   describe('development environment', () => {
      beforeEach(() => {
         (envConfig as any).MODE = 'development';
      });

      it('prepends EXPLAIN (FORMAT JSON) to the provided SQL', async () => {
         const planNode = { 'Node Type': 'Seq Scan', 'Relation Name': 'CreatorProfile' };
         queryRawUnsafeMock.mockResolvedValueOnce([{ 'QUERY PLAN': [planNode] }]);

         await captureQueryPlan('SELECT * FROM "CreatorProfile"');

         expect(queryRawUnsafeMock).toHaveBeenCalledWith(
            'EXPLAIN (FORMAT JSON) SELECT * FROM "CreatorProfile"'
         );
      });

      it('forwards bound parameters to $queryRawUnsafe', async () => {
         queryRawUnsafeMock.mockResolvedValueOnce([{ 'QUERY PLAN': [] }]);

         await captureQueryPlan('SELECT * FROM "CreatorProfile" WHERE "isVerified" = $1', [true]);

         expect(queryRawUnsafeMock).toHaveBeenCalledWith(
            'EXPLAIN (FORMAT JSON) SELECT * FROM "CreatorProfile" WHERE "isVerified" = $1',
            true
         );
      });

      it('returns the QUERY PLAN array from the first result row', async () => {
         const planNode = { 'Node Type': 'Index Scan', 'Index Name': 'idx_creator_verified' };
         queryRawUnsafeMock.mockResolvedValueOnce([{ 'QUERY PLAN': [planNode] }]);

         const result = await captureQueryPlan('SELECT * FROM "CreatorProfile"');

         expect(result).toEqual([planNode]);
      });

      it('returns null when the database throws instead of propagating the error', async () => {
         queryRawUnsafeMock.mockRejectedValueOnce(new Error('syntax error'));

         const result = await captureQueryPlan('SELECT * FROM "CreatorProfile"');

         expect(result).toBeNull();
      });

      it('returns null when the result row has no QUERY PLAN key', async () => {
         queryRawUnsafeMock.mockResolvedValueOnce([{}]);

         const result = await captureQueryPlan('SELECT * FROM "CreatorProfile"');

         expect(result).toBeNull();
      });

      it('returns null when the result set is empty', async () => {
         queryRawUnsafeMock.mockResolvedValueOnce([]);

         const result = await captureQueryPlan('SELECT * FROM "CreatorProfile"');

         expect(result).toBeNull();
      });
   });
});
