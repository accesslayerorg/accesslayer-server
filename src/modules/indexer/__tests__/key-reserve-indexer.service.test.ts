// src/modules/indexer/__tests__/key-reserve-indexer.service.test.ts
import { Decimal } from '@prisma/client/runtime/library';

const prismaMock = {
   keyReserve: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
   },
};

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: prismaMock,
}));

const mockInvalidateCache = jest.fn();
jest.mock('../../keys/key-reserve.service', () => ({
   invalidateKeyReserveCache: mockInvalidateCache,
}));

import {
   processKeyReserveEvents,
   ReserveAccruedChainEvent,
   ReserveDeployedChainEvent,
} from '../key-reserve-indexer.service';

describe('key-reserve-indexer.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('handles ReserveAccrued when no prior reserve exists', async () => {
      prismaMock.keyReserve.findUnique.mockResolvedValueOnce(null);
      prismaMock.keyReserve.upsert.mockResolvedValueOnce({});

      const event: ReserveAccruedChainEvent = {
         eventType: 'ReserveAccrued',
         keyId: 'key-accrue-1',
         amount: '500',
         txHash: '0x123',
         ledger: 100,
         eventIndex: 0,
         timestamp: new Date().toISOString(),
      };

      await processKeyReserveEvents([event]);

      expect(prismaMock.keyReserve.upsert).toHaveBeenCalledWith({
         where: { keyId: 'key-accrue-1' },
         create: {
            keyId: 'key-accrue-1',
            reserveBalance: new Decimal('500'),
         },
         update: {
            reserveBalance: new Decimal('500'),
         },
      });
      expect(mockInvalidateCache).toHaveBeenCalledWith('key-accrue-1');
   });

   it('adds to existing balance on ReserveAccrued', async () => {
      prismaMock.keyReserve.findUnique.mockResolvedValueOnce({
         keyId: 'key-accrue-2',
         reserveBalance: new Decimal('1000'),
      });
      prismaMock.keyReserve.upsert.mockResolvedValueOnce({});

      const event: ReserveAccruedChainEvent = {
         eventType: 'ReserveAccrued',
         keyId: 'key-accrue-2',
         amount: '500',
         txHash: '0x124',
         ledger: 101,
         eventIndex: 0,
         timestamp: new Date().toISOString(),
      };

      await processKeyReserveEvents([event]);

      expect(prismaMock.keyReserve.upsert).toHaveBeenCalledWith({
         where: { keyId: 'key-accrue-2' },
         create: {
            keyId: 'key-accrue-2',
            reserveBalance: new Decimal('1500'),
         },
         update: {
            reserveBalance: new Decimal('1500'),
         },
      });
      expect(mockInvalidateCache).toHaveBeenCalledWith('key-accrue-2');
   });

   it('subtracts from existing balance on ReserveDeployed', async () => {
      prismaMock.keyReserve.findUnique.mockResolvedValueOnce({
         keyId: 'key-deploy-1',
         reserveBalance: new Decimal('1000'),
      });
      prismaMock.keyReserve.upsert.mockResolvedValueOnce({});

      const event: ReserveDeployedChainEvent = {
         eventType: 'ReserveDeployed',
         keyId: 'key-deploy-1',
         amount: '400',
         txHash: '0x125',
         ledger: 102,
         eventIndex: 0,
         timestamp: new Date().toISOString(),
      };

      await processKeyReserveEvents([event]);

      expect(prismaMock.keyReserve.upsert).toHaveBeenCalledWith({
         where: { keyId: 'key-deploy-1' },
         create: {
            keyId: 'key-deploy-1',
            reserveBalance: new Decimal('600'),
         },
         update: {
            reserveBalance: new Decimal('600'),
         },
      });
      expect(mockInvalidateCache).toHaveBeenCalledWith('key-deploy-1');
   });

   it('clamps to zero if ReserveDeployed exceeds balance', async () => {
      prismaMock.keyReserve.findUnique.mockResolvedValueOnce({
         keyId: 'key-deploy-2',
         reserveBalance: new Decimal('100'),
      });
      prismaMock.keyReserve.upsert.mockResolvedValueOnce({});

      const event: ReserveDeployedChainEvent = {
         eventType: 'ReserveDeployed',
         keyId: 'key-deploy-2',
         amount: '500',
         txHash: '0x126',
         ledger: 103,
         eventIndex: 0,
         timestamp: new Date().toISOString(),
      };

      await processKeyReserveEvents([event]);

      expect(prismaMock.keyReserve.upsert).toHaveBeenCalledWith({
         where: { keyId: 'key-deploy-2' },
         create: {
            keyId: 'key-deploy-2',
            reserveBalance: new Decimal('0'),
         },
         update: {
            reserveBalance: new Decimal('0'),
         },
      });
      expect(mockInvalidateCache).toHaveBeenCalledWith('key-deploy-2');
   });

   it('ignores unrelated event types', async () => {
      const event: any = {
         eventType: 'OTHER_EVENT',
         keyId: 'key-other',
         txHash: '0x127',
      };

      await processKeyReserveEvents([event]);

      expect(prismaMock.keyReserve.upsert).not.toHaveBeenCalled();
      expect(mockInvalidateCache).not.toHaveBeenCalled();
   });
});
