// src/modules/keys/__tests__/content-gate.service.test.ts
import { Decimal } from '@prisma/client/runtime/library';

let cacheStore = new Map<string, any>();
const redisSubscribers = new Set<string>();

jest.mock('../../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
   cacheSetJson: jest.fn(async (key: string, val: any) => {
      cacheStore.set(key, val);
   }),
   cacheInvalidate: jest.fn(async (key: string) => {
      cacheStore.delete(key);
   }),
   getRedis: jest.fn(() => ({
      sismember: jest.fn(async (key: string, member: string) => {
         return redisSubscribers.has(`${key}:${member}`) ? 1 : 0;
      }),
   })),
}));

const prismaMock = {
   creatorProfile: {
      findUnique: jest.fn(),
   },
   keyContentGate: {
      findUnique: jest.fn(),
   },
   keyOwnership: {
      findUnique: jest.fn(),
   },
};

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: prismaMock,
}));

import {
   checkContentAccess,
   invalidateContentAccessCache,
   KeyNotFoundError,
} from '../content-gate.service';

describe('content-gate.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      cacheStore.clear();
      redisSubscribers.clear();
   });

   it('throws KeyNotFoundError if key does not exist', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValueOnce(null);

      await expect(checkContentAccess('unknown-key', 'GWALLET')).rejects.toThrow(KeyNotFoundError);
   });

   it('returns is_allowed: true for ungated key', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({ id: 'key-ungated' });
      prismaMock.keyContentGate.findUnique.mockResolvedValueOnce(null);

      const res = await checkContentAccess('key-ungated', 'GWALLET');

      expect(res.key_id).toBe('key-ungated');
      expect(res.wallet).toBe('GWALLET');
      expect(res.is_allowed).toBe(true);
      expect(res.gate_type).toBe('none');
      expect(res.requirement).toBeNull();
   });

   it('evaluates hold_balance gate correctly', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValue({ id: 'key-hold' });
      prismaMock.keyContentGate.findUnique.mockResolvedValue({
         keyId: 'key-hold',
         gateType: 'hold_balance',
         requirement: JSON.stringify({ min_balance: 5 }),
         isActive: true,
      });

      // Wallet with insufficient balance
      prismaMock.keyOwnership.findUnique.mockResolvedValueOnce({
         balance: new Decimal(3),
      });

      const resFail = await checkContentAccess('key-hold', 'GPOOR');
      expect(resFail.is_allowed).toBe(false);
      expect(resFail.gate_type).toBe('hold_balance');

      cacheStore.clear();

      // Wallet with sufficient balance
      prismaMock.keyOwnership.findUnique.mockResolvedValueOnce({
         balance: new Decimal(10),
      });

      const resPass = await checkContentAccess('key-hold', 'GRICH');
      expect(resPass.is_allowed).toBe(true);
      expect(resPass.gate_type).toBe('hold_balance');
   });

   it('evaluates subscription gate correctly', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValue({ id: 'key-sub' });
      prismaMock.keyContentGate.findUnique.mockResolvedValue({
         keyId: 'key-sub',
         gateType: 'subscription',
         requirement: '{}',
         isActive: true,
      });

      // No subscription
      const resNoSub = await checkContentAccess('key-sub', 'GWALLET1');
      expect(resNoSub.is_allowed).toBe(false);
      expect(resNoSub.gate_type).toBe('subscription');

      cacheStore.clear();

      // Active subscription
      redisSubscribers.add('key:key-sub:subscribers:GWALLET2');

      const resWithSub = await checkContentAccess('key-sub', 'GWALLET2');
      expect(resWithSub.is_allowed).toBe(true);
      expect(resWithSub.gate_type).toBe('subscription');
   });

   it('evaluates nft_pass gate correctly', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValue({ id: 'key-pass' });
      prismaMock.keyContentGate.findUnique.mockResolvedValue({
         keyId: 'key-pass',
         gateType: 'nft_pass',
         requirement: JSON.stringify({ pass_id: 'vip-pass-key' }),
         isActive: true,
      });

      // Pass not owned
      prismaMock.keyOwnership.findUnique.mockResolvedValueOnce(null);

      const resNoPass = await checkContentAccess('key-pass', 'GWALLET1');
      expect(resNoPass.is_allowed).toBe(false);
      expect(resNoPass.gate_type).toBe('nft_pass');

      cacheStore.clear();

      // Pass owned
      prismaMock.keyOwnership.findUnique.mockResolvedValueOnce({
         balance: new Decimal(1),
      });

      const resWithPass = await checkContentAccess('key-pass', 'GWALLET2');
      expect(resWithPass.is_allowed).toBe(true);
      expect(resWithPass.gate_type).toBe('nft_pass');
   });

   it('returns cached response when available', async () => {
      const cached = {
         key_id: 'k-c',
         wallet: 'w-c',
         is_allowed: true,
         gate_type: 'none' as const,
         requirement: null,
      };
      cacheStore.set('key:k-c:content-access:w-c', cached);

      const res = await checkContentAccess('k-c', 'w-c');

      expect(res).toEqual(cached);
      expect(prismaMock.creatorProfile.findUnique).not.toHaveBeenCalled();
   });

   it('invalidates cache correctly', async () => {
      cacheStore.set('key:k-inv:content-access:w-inv', true);

      await invalidateContentAccessCache('k-inv', 'w-inv');

      expect(cacheStore.has('key:k-inv:content-access:w-inv')).toBe(false);
   });
});
