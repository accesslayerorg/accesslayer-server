// src/modules/indexer/__tests__/key-cocreator-indexer.service.test.ts
const prismaMock = {
   keyCoCreator: {
      upsert: jest.fn(),
      updateMany: jest.fn(),
   },
};

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: prismaMock,
}));

const mockInvalidateCache = jest.fn();
jest.mock('../../keys/key-cocreator.service', () => ({
   invalidateCoCreatorCache: mockInvalidateCache,
}));

import {
   processKeyCoCreatorEvents,
   CoCreatorAddedChainEvent,
   CoCreatorRemovedChainEvent,
} from '../key-cocreator-indexer.service';

describe('key-cocreator-indexer.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('handles CoCreatorAdded event and upserts active status with role', async () => {
      prismaMock.keyCoCreator.upsert.mockResolvedValueOnce({});

      const timestamp = '2026-03-01T10:00:00Z';
      const event: CoCreatorAddedChainEvent = {
         eventType: 'CoCreatorAdded',
         keyId: 'key-100',
         wallet: 'GCOCREATOR1',
         role: 'moderator',
         txHash: '0xabc',
         ledger: 200,
         eventIndex: 0,
         timestamp,
      };

      await processKeyCoCreatorEvents([event]);

      expect(prismaMock.keyCoCreator.upsert).toHaveBeenCalledWith({
         where: {
            keyId_wallet: {
               keyId: 'key-100',
               wallet: 'GCOCREATOR1',
            },
         },
         create: {
            keyId: 'key-100',
            wallet: 'GCOCREATOR1',
            role: 'moderator',
            isActive: true,
            addedAt: new Date(timestamp),
            removedAt: null,
         },
         update: {
            role: 'moderator',
            isActive: true,
            addedAt: new Date(timestamp),
            removedAt: null,
         },
      });
      expect(mockInvalidateCache).toHaveBeenCalledWith('key-100', 'GCOCREATOR1');
   });

   it('defaults to contributor role when CoCreatorAdded has no role', async () => {
      prismaMock.keyCoCreator.upsert.mockResolvedValueOnce({});

      const event: CoCreatorAddedChainEvent = {
         eventType: 'CoCreatorAdded',
         keyId: 'key-101',
         wallet: 'GCOCREATOR2',
         txHash: '0xabd',
         ledger: 201,
         eventIndex: 0,
      };

      await processKeyCoCreatorEvents([event]);

      expect(prismaMock.keyCoCreator.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            create: expect.objectContaining({
               role: 'contributor',
               isActive: true,
            }),
         })
      );
      expect(mockInvalidateCache).toHaveBeenCalledWith('key-101', 'GCOCREATOR2');
   });

   it('handles CoCreatorRemoved event and marks isActive false with removedAt', async () => {
      prismaMock.keyCoCreator.updateMany.mockResolvedValueOnce({ count: 1 });

      const timestamp = '2026-03-02T12:00:00Z';
      const event: CoCreatorRemovedChainEvent = {
         eventType: 'CoCreatorRemoved',
         keyId: 'key-102',
         wallet: 'GREMOVED1',
         txHash: '0xabe',
         ledger: 202,
         eventIndex: 0,
         timestamp,
      };

      await processKeyCoCreatorEvents([event]);

      expect(prismaMock.keyCoCreator.updateMany).toHaveBeenCalledWith({
         where: {
            keyId: 'key-102',
            wallet: 'GREMOVED1',
         },
         data: {
            isActive: false,
            removedAt: new Date(timestamp),
         },
      });
      expect(mockInvalidateCache).toHaveBeenCalledWith('key-102', 'GREMOVED1');
   });

   it('ignores unrelated event types', async () => {
      const event: any = {
         eventType: 'UNRELATED_EVENT',
         keyId: 'key-103',
         txHash: '0xabf',
      };

      await processKeyCoCreatorEvents([event]);

      expect(prismaMock.keyCoCreator.upsert).not.toHaveBeenCalled();
      expect(prismaMock.keyCoCreator.updateMany).not.toHaveBeenCalled();
      expect(mockInvalidateCache).not.toHaveBeenCalled();
   });
});
