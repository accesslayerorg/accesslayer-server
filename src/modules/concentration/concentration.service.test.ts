jest.unmock('@prisma/client');
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn() },
      keyOwnership: { findMany: jest.fn() },
      registeredKey: { findMany: jest.fn() },
      factoryDeployedKey: { findMany: jest.fn() },
   },
}));
jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn(),
   cacheInvalidate: jest.fn(),
}));

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import {
   calculateConcentration,
   ConcentrationService,
   concentrationCacheKey,
   onConcentrationBalanceChanged,
} from './concentration.service';

describe('holder concentration arithmetic', () => {
   it('returns zero inequality for equal balances and sorted top-N shares', () => {
      const result = calculateConcentration(['100', '100', '100', '100', '100', '100']);
      expect(result.holderCount).toBe(6);
      expect(result.giniCoefficient).toBe(0);
      expect(result.top1Share).toBeCloseTo(1 / 6);
      expect(result.top5Share).toBeCloseTo(5 / 6);
      expect(result.top10Share).toBe(1);
   });

   it('handles an empty key and a single holder without division errors', () => {
      expect(calculateConcentration([])).toMatchObject({
         holderCount: 0, giniCoefficient: 0, top1Share: 0, concentrationLevel: 'low',
      });
      expect(calculateConcentration(['50'])).toMatchObject({
         holderCount: 1, giniCoefficient: 0, top1Share: 1, concentrationLevel: 'high',
      });
   });

   it('computes skewed balances without rounding large amounts into equal values', () => {
      const result = calculateConcentration([
         '1', '1', '1', '1', '1', '1', '1', '1', '1',
         '99999999999999999999999999999999999999999999999999',
      ]);
      expect(result.giniCoefficient).toBeCloseTo(0.9);
      expect(result.top1Share).toBeCloseTo(1);
      expect(result.concentrationLevel).toBe('high');
   });

   it('uses configured medium and high top-holder thresholds', () => {
      expect(calculateConcentration(['2', '3', '5'], { medium: 0.5, high: 0.8 })
         .concentrationLevel).toBe('medium');
      expect(calculateConcentration(['2', '3', '5'], { medium: 0.2, high: 0.5 })
         .concentrationLevel).toBe('high');
   });

   it('sorts decimal balances numerically and ignores zero balances', () => {
      const result = calculateConcentration(['0', '0.1', '10', '2']);
      expect(result.holderCount).toBe(3);
      expect(result.top1Share).toBeCloseTo(10 / 12.1);
   });
});

describe('ConcentrationService', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (cacheGetJson as jest.Mock).mockResolvedValue(null);
      (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({ id: 'key-1' });
      (prisma.factoryDeployedKey.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.registeredKey.findMany as jest.Mock).mockResolvedValue([{ keyAddress: 'reserve-account' }]);
      (prisma.keyOwnership.findMany as jest.Mock).mockResolvedValue([
         { ownerAddress: 'wallet-a', balance: '10' },
         { ownerAddress: 'C' + 'A'.repeat(55), balance: '990' },
         { ownerAddress: 'reserve-account', balance: '1000' },
      ]);
   });

   it('excludes contracts and registered reserve addresses by default', async () => {
      const result = await ConcentrationService.compute('key-1');
      expect(result.holderCount).toBe(1);
      expect(cacheSetJson).toHaveBeenCalledWith(concentrationCacheKey('key-1', false), result, 300);
   });

   it('includes contracts only when requested', async () => {
      const result = await ConcentrationService.compute('key-1', true);
      expect(result.holderCount).toBe(3);
      expect(result.top1Share).toBe(0.5);
   });

   it('serves cached statistics without loading balances', async () => {
      const cached = { keyId: 'key-1', ...calculateConcentration(['10']) };
      (cacheGetJson as jest.Mock).mockResolvedValue(cached);
      expect(await ConcentrationService.compute('key-1')).toEqual(cached);
      expect(prisma.keyOwnership.findMany).not.toHaveBeenCalled();
   });

   it('invalidates both cached variants after a balance change', async () => {
      await onConcentrationBalanceChanged('key-1');
      expect(cacheInvalidate).toHaveBeenCalledWith(concentrationCacheKey('key-1', false));
      expect(cacheInvalidate).toHaveBeenCalledWith(concentrationCacheKey('key-1', true));
   });
});
