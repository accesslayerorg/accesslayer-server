// src/modules/indexer/price-ceiling-indexer.service.test.ts

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      priceCeiling: {
         upsert: jest.fn(),
         findUnique: jest.fn(),
         update: jest.fn(),
         create: jest.fn(),
      },
   },
}));

jest.mock('../keys/price-ceiling.service', () => ({
   invalidatePriceCeilingCache: jest.fn(),
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
import { invalidatePriceCeilingCache } from '../keys/price-ceiling.service';
import {
   processPriceCeilingEvents,
   PriceCeilingChainEvent,
} from './price-ceiling-indexer.service';

const mockPrisma = prisma as unknown as {
   priceCeiling: {
      upsert: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
   };
};
const mockInvalidateCache = invalidatePriceCeilingCache as jest.Mock;

describe('price-ceiling-indexer.service', () => {
   const KEY_ID = 'key-uuid-1';

   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('ceiling_set event', () => {
      it('indexes ceiling_set and creates/updates PriceCeiling record', async () => {
         const event: PriceCeilingChainEvent = {
            eventType: 'ceiling_set',
            keyId: KEY_ID,
            ceiling: 1000,
            cooloffLedgers: 50,
            ledger: 100,
            txHash: '0xset1',
            eventIndex: 0,
         };

         await processPriceCeilingEvents([event]);

         expect(mockPrisma.priceCeiling.upsert).toHaveBeenCalledWith({
            where: { keyId: KEY_ID },
            create: {
               keyId: KEY_ID,
               ceiling: new Decimal('1000'),
               cooloffLedgers: 50,
               cooloffEndsAt: null,
            },
            update: {
               ceiling: new Decimal('1000'),
               cooloffLedgers: 50,
               cooloffEndsAt: null,
            },
         });
         expect(mockInvalidateCache).toHaveBeenCalledWith(KEY_ID);
      });

      it('accepts alternative casing CEILING_SET', async () => {
         const event: PriceCeilingChainEvent = {
            eventType: 'CEILING_SET',
            creatorId: KEY_ID,
            ceiling: '2500.5',
            cooloffLedgers: 100,
            ledger: 100,
            txHash: '0xset2',
            eventIndex: 0,
         };

         await processPriceCeilingEvents([event]);

         expect(mockPrisma.priceCeiling.upsert).toHaveBeenCalledWith({
            where: { keyId: KEY_ID },
            create: {
               keyId: KEY_ID,
               ceiling: new Decimal('2500.5'),
               cooloffLedgers: 100,
               cooloffEndsAt: null,
            },
            update: {
               ceiling: new Decimal('2500.5'),
               cooloffLedgers: 100,
               cooloffEndsAt: null,
            },
         });
      });

      it('skips ceiling_set event with missing ceiling', async () => {
         const event: PriceCeilingChainEvent = {
            eventType: 'ceiling_set',
            keyId: KEY_ID,
            ledger: 100,
            txHash: '0xset-missing',
            eventIndex: 0,
         };

         await processPriceCeilingEvents([event]);

         expect(mockPrisma.priceCeiling.upsert).not.toHaveBeenCalled();
      });
   });

   describe('ceiling_hit event', () => {
      it('starts cool-off with the correct end ledger based on existing cooloffLedgers', async () => {
         mockPrisma.priceCeiling.findUnique.mockResolvedValue({
            keyId: KEY_ID,
            ceiling: new Decimal('1000'),
            cooloffLedgers: 75,
            cooloffEndsAt: null,
         });

         const event: PriceCeilingChainEvent = {
            eventType: 'ceiling_hit',
            keyId: KEY_ID,
            ledger: 1000,
            txHash: '0xhit1',
            eventIndex: 0,
         };

         await processPriceCeilingEvents([event]);

         expect(mockPrisma.priceCeiling.update).toHaveBeenCalledWith({
            where: { keyId: KEY_ID },
            data: {
               cooloffEndsAt: 1075, // 1000 + 75
            },
         });
         expect(mockInvalidateCache).toHaveBeenCalledWith(KEY_ID);
      });

      it('respects cooloffEndsAt / endLedger explicitly provided in event', async () => {
         mockPrisma.priceCeiling.findUnique.mockResolvedValue({
            keyId: KEY_ID,
            ceiling: new Decimal('1000'),
            cooloffLedgers: 75,
         });

         const event: PriceCeilingChainEvent = {
            eventType: 'ceiling_hit',
            keyId: KEY_ID,
            endLedger: 1200,
            ledger: 1000,
            txHash: '0xhit2',
            eventIndex: 0,
         };

         await processPriceCeilingEvents([event]);

         expect(mockPrisma.priceCeiling.update).toHaveBeenCalledWith({
            where: { keyId: KEY_ID },
            data: {
               cooloffEndsAt: 1200,
            },
         });
      });

      it('creates ceiling record if ceiling is provided on hit for unknown key', async () => {
         mockPrisma.priceCeiling.findUnique.mockResolvedValue(null);

         const event: PriceCeilingChainEvent = {
            eventType: 'ceiling_hit',
            keyId: KEY_ID,
            ceiling: 500,
            cooloffLedgers: 30,
            ledger: 200,
            txHash: '0xhit3',
            eventIndex: 0,
         };

         await processPriceCeilingEvents([event]);

         expect(mockPrisma.priceCeiling.create).toHaveBeenCalledWith({
            data: {
               keyId: KEY_ID,
               ceiling: new Decimal('500'),
               cooloffLedgers: 30,
               cooloffEndsAt: 230,
            },
         });
      });
   });

   describe('ceiling_raised event', () => {
      it('updates the stored ceiling value', async () => {
         const event: PriceCeilingChainEvent = {
            eventType: 'ceiling_raised',
            keyId: KEY_ID,
            ceiling: 1500,
            ledger: 200,
            txHash: '0xraise1',
            eventIndex: 0,
         };

         await processPriceCeilingEvents([event]);

         expect(mockPrisma.priceCeiling.upsert).toHaveBeenCalledWith({
            where: { keyId: KEY_ID },
            create: {
               keyId: KEY_ID,
               ceiling: new Decimal('1500'),
               cooloffLedgers: 0,
               cooloffEndsAt: null,
            },
            update: {
               ceiling: new Decimal('1500'),
            },
         });
         expect(mockInvalidateCache).toHaveBeenCalledWith(KEY_ID);
      });

      it('accepts newCeiling alias on ceiling_raised', async () => {
         const event: PriceCeilingChainEvent = {
            eventType: 'CEILING_RAISED',
            keyId: KEY_ID,
            newCeiling: 2000,
            ledger: 250,
            txHash: '0xraise2',
            eventIndex: 0,
         };

         await processPriceCeilingEvents([event]);

         expect(mockPrisma.priceCeiling.upsert).toHaveBeenCalledWith({
            where: { keyId: KEY_ID },
            create: {
               keyId: KEY_ID,
               ceiling: new Decimal('2000'),
               cooloffLedgers: 0,
               cooloffEndsAt: null,
            },
            update: {
               ceiling: new Decimal('2000'),
            },
         });
      });
   });

   describe('validation and deduplication', () => {
      it('skips duplicate events in the same batch', async () => {
         const event: PriceCeilingChainEvent = {
            eventType: 'ceiling_set',
            keyId: KEY_ID,
            ceiling: 1000,
            ledger: 100,
            txHash: '0xdup',
            eventIndex: 0,
         };

         await processPriceCeilingEvents([event, { ...event }]);

         expect(mockPrisma.priceCeiling.upsert).toHaveBeenCalledTimes(1);
      });

      it('skips events missing key identifier', async () => {
         const event: PriceCeilingChainEvent = {
            eventType: 'ceiling_set',
            ceiling: 1000,
            ledger: 100,
            txHash: '0xnokey',
            eventIndex: 0,
         };

         await processPriceCeilingEvents([event]);

         expect(mockPrisma.priceCeiling.upsert).not.toHaveBeenCalled();
      });

      it('ignores unrelated event types', async () => {
         await processPriceCeilingEvents([
            {
               eventType: 'KEY_BOUGHT',
               keyId: KEY_ID,
               ledger: 100,
               txHash: '0xunrelated',
               eventIndex: 0,
            } as any,
         ]);

         expect(mockPrisma.priceCeiling.upsert).not.toHaveBeenCalled();
         expect(mockPrisma.priceCeiling.update).not.toHaveBeenCalled();
      });
   });
});
