// src/modules/keys/price-ceiling.service.test.ts

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: jest.fn(),
      },
      priceCeiling: {
         findUnique: jest.fn(),
      },
      creatorPriceSnapshot: {
         findUnique: jest.fn(),
      },
      trade: {
         findFirst: jest.fn(),
      },
      indexedLedger: {
         findFirst: jest.fn(),
      },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../utils/prisma.utils';
import {
   getPriceCeilingStatus,
   computeHeadroom,
   isCooloffActive,
   KeyNotFoundError,
} from './price-ceiling.service';

const mockPrisma = prisma as unknown as {
   creatorProfile: { findFirst: jest.Mock };
   priceCeiling: { findUnique: jest.Mock };
   creatorPriceSnapshot: { findUnique: jest.Mock };
   trade: { findFirst: jest.Mock };
   indexedLedger: { findFirst: jest.Mock };
};

describe('price-ceiling.service', () => {
   const KEY_ID = 'creator-key-1';

   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('computeHeadroom', () => {
      it('calculates headroom as (ceiling - price) / ceiling', () => {
         const { headroom, headroomPercentage } = computeHeadroom(100, 20);
         expect(headroom).toBeCloseTo(0.8);
         expect(headroomPercentage).toBeCloseTo(80);
      });

      it('returns 0 headroom when price equals ceiling', () => {
         const { headroom, headroomPercentage } = computeHeadroom(100, 100);
         expect(headroom).toBe(0);
         expect(headroomPercentage).toBe(0);
      });

      it('returns 1.0 (100%) when price is 0 or null', () => {
         const { headroom, headroomPercentage } = computeHeadroom(100, 0);
         expect(headroom).toBe(1);
         expect(headroomPercentage).toBe(100);

         const nullPrice = computeHeadroom(100, null);
         expect(nullPrice.headroom).toBe(1);
      });

      it('returns null headroom when ceiling is null or non-positive', () => {
         expect(computeHeadroom(null, 50).headroom).toBeNull();
         expect(computeHeadroom(0, 50).headroom).toBeNull();
      });
   });

   describe('isCooloffActive', () => {
      it('returns false when cooloffEndsAt is null', async () => {
         expect(await isCooloffActive(null)).toBe(false);
         expect(await isCooloffActive(undefined)).toBe(false);
      });

      it('returns true when current ledger <= cooloffEndsAt', async () => {
         expect(await isCooloffActive(150, 100)).toBe(true);
         expect(await isCooloffActive(150, 150)).toBe(true);
      });

      it('returns false when current ledger > cooloffEndsAt', async () => {
         expect(await isCooloffActive(150, 151)).toBe(false);
      });

      it('queries indexedLedger from database when currentLedger is not passed', async () => {
         mockPrisma.indexedLedger.findFirst.mockResolvedValue({ ledger: 120 });
         expect(await isCooloffActive(150)).toBe(true);

         mockPrisma.indexedLedger.findFirst.mockResolvedValue({ ledger: 160 });
         expect(await isCooloffActive(150)).toBe(false);
      });
   });

   describe('getPriceCeilingStatus', () => {
      it('returns null ceiling fields for keys without a ceiling', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({ id: KEY_ID });
         mockPrisma.priceCeiling.findUnique.mockResolvedValue(null);

         const status = await getPriceCeilingStatus(KEY_ID);

         expect(status).toEqual({
            keyId: KEY_ID,
            ceiling: null,
            price: null,
            headroom: null,
            headroomPercentage: null,
            cooloffActive: null,
            cooloffEndsAt: null,
            cooloffLedgers: null,
         });
      });

      it('returns ceiling, computed headroom, and active cool-off state when configured', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue({ id: KEY_ID });
         mockPrisma.priceCeiling.findUnique.mockResolvedValue({
            keyId: KEY_ID,
            ceiling: new Decimal('1000'),
            cooloffLedgers: 50,
            cooloffEndsAt: 250,
         });
         mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue({
            currentPrice: 200n,
         });
         mockPrisma.indexedLedger.findFirst.mockResolvedValue({ ledger: 220 });

         const status = await getPriceCeilingStatus(KEY_ID);

         expect(status.keyId).toBe(KEY_ID);
         expect(status.ceiling).toBe(1000);
         expect(status.price).toBe(200);
         expect(status.headroom).toBeCloseTo(0.8);
         expect(status.headroomPercentage).toBeCloseTo(80);
         expect(status.cooloffActive).toBe(true);
         expect(status.cooloffEndsAt).toBe(250);
         expect(status.cooloffLedgers).toBe(50);
      });

      it('throws KeyNotFoundError when key does not exist', async () => {
         mockPrisma.creatorProfile.findFirst.mockResolvedValue(null);

         await expect(getPriceCeilingStatus('unknown-key')).rejects.toThrow(
            KeyNotFoundError
         );
      });
   });
});
