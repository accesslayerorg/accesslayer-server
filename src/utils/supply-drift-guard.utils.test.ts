import {
   verifySupplyAndGuard,
   isDriftHalted,
   assertNoSupplyDrift,
   clearDrift,
   SupplyDriftHaltedError,
} from './supply-drift-guard.utils';

jest.mock('./logger.utils', () => ({
   logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

jest.mock('./redis.utils', () => {
   const store = new Map<string, string>();
   return {
      getRedis: () => ({
         exists: jest
            .fn()
            .mockImplementation(async (key: string) =>
               store.has(key) ? 1 : 0
            ),
         set: jest.fn().mockImplementation(async (key: string, val: string) => {
            store.set(key, val);
            return 'OK';
         }),
         del: jest.fn().mockImplementation(async (key: string) => {
            store.delete(key);
            return 1;
         }),
         _store: store,
      }),
   };
});

describe('Supply Drift Guard (#758)', () => {
   const creatorWallet = 'GCREATOR12345';

   beforeEach(async () => {
      await clearDrift(creatorWallet);
   });

   it('returns true when expected supply matches actual supply', async () => {
      const match = await verifySupplyAndGuard(creatorWallet, 10, 10);
      expect(match).toBe(true);

      const halted = await isDriftHalted(creatorWallet);
      expect(halted).toBe(false);
   });

   it('detects supply drift, sets Redis flag, and returns false when supplies diverge', async () => {
      const match = await verifySupplyAndGuard(creatorWallet, 10, 12);
      expect(match).toBe(false);

      const halted = await isDriftHalted(creatorWallet);
      expect(halted).toBe(true);
   });

   it('assertNoSupplyDrift throws SupplyDriftHaltedError when drift flag is set', async () => {
      await verifySupplyAndGuard(creatorWallet, 10, 15);

      await expect(assertNoSupplyDrift(creatorWallet)).rejects.toThrow(
         SupplyDriftHaltedError
      );
   });

   it('clearDrift removes the drift flag and allows operations to resume', async () => {
      await verifySupplyAndGuard(creatorWallet, 10, 15);
      expect(await isDriftHalted(creatorWallet)).toBe(true);

      await clearDrift(creatorWallet);

      expect(await isDriftHalted(creatorWallet)).toBe(false);
      await expect(assertNoSupplyDrift(creatorWallet)).resolves.not.toThrow();
   });
});
