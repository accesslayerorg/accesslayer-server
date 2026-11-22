import { FlagService } from './feature-flags.service';

function definition(name: string, enabled: boolean, rules: unknown) {
   return {
      name,
      enabled,
      rules,
      updatedBy: 'test-admin',
      updatedAt: new Date(),
   };
}

describe('FlagService', () => {
   it('disabled flags evaluate false for everyone', async () => {
      const findMany = jest.fn().mockResolvedValue([
         definition('test.disabled', false, {}),
      ]);
      const service = new FlagService({
         featureFlag: { findMany, findUnique: jest.fn(), upsert: jest.fn() },
      } as any);

      await expect(service.evaluate('test.disabled', { wallet: 'G123' }))
         .resolves.toBe(false);
   });

   it('environment rules require a matching environment', () => {
      const service = new FlagService();
      const flag = definition('test.environment', true, {
         environment: ['production'],
      });

      expect(service.evaluateDefinition(flag, { environment: 'production' })).toBe(true);
      expect(service.evaluateDefinition(flag, { environment: 'test' })).toBe(false);
   });

   it('allowlisted wallets always evaluate true', () => {
      const service = new FlagService();
      const flag = definition('test.allowlist', true, {
         allowlist: ['GALLOWLISTED'],
         percentage: 0,
      });

      expect(service.evaluateDefinition(flag, { wallet: 'GALLOWLISTED' })).toBe(true);
      expect(service.evaluateDefinition(flag, { wallet: 'GOTHER' })).toBe(false);
   });

   it('percentage rollout is stable for the same wallet', () => {
      const service = new FlagService();
      const flag = definition('test.percentage', true, { percentage: 50 });

      const first = service.evaluateDefinition(flag, { wallet: 'GSTABLEWALLET' });
      const second = service.evaluateDefinition(flag, { wallet: 'GSTABLEWALLET' });
      expect(first).toBe(second);
   });

   it('caches definitions and invalidates after updates', async () => {
      const findMany = jest.fn().mockResolvedValue([
         definition('test.cache', true, {}),
      ]);
      const upsert = jest.fn().mockResolvedValue(
         definition('test.cache', false, {})
      );
      const service = new FlagService({
         featureFlag: { findMany, findUnique: jest.fn(), upsert },
      } as any);

      await service.listDefinitions();
      await service.listDefinitions();
      expect(findMany).toHaveBeenCalledTimes(1);

      await service.update('test.cache', false, {}, 'admin');
      await service.listDefinitions();
      expect(findMany).toHaveBeenCalledTimes(2);
   });
});
