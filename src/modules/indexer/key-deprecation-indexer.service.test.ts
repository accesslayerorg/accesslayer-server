// src/modules/indexer/key-deprecation-indexer.service.test.ts
const prismaMock = {
   creatorProfile: {
      findUnique: jest.fn(),
      update: jest.fn(),
   },
   keyOwnership: {
      findMany: jest.fn(),
   },
   activityLog: {
      create: jest.fn(),
   },
};

jest.mock('../../utils/prisma.utils', () => ({
   prisma: prismaMock,
}));

jest.mock('../../utils/redis.utils', () => ({
   getRedis: () => null,
}));

jest.mock('../creator/creator-dashboard.service', () => ({
   invalidateCreatorDashboardCache: jest.fn().mockResolvedValue(undefined),
}));

import { processKeyDeprecationEvents } from './key-deprecation-indexer.service';
import { invalidateCreatorDashboardCache } from '../creator/creator-dashboard.service';
import { KeyDeprecationChainEvent } from './key-deprecation-indexer.service';

describe('processKeyDeprecationEvents', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      prismaMock.keyOwnership.findMany.mockResolvedValue([]);
   });

   function makeEvent(
      overrides: Partial<KeyDeprecationChainEvent> = {}
   ): KeyDeprecationChainEvent {
      return {
         eventType: 'KEY_DEPRECATED',
         txHash: 'tx-1',
         eventIndex: 0,
         ledger: 100,
         creatorId: 'creator-1',
         ...overrides,
      };
   }

   it('marks an active key deprecated, stores reason/successor, and invalidates cache', async () => {
      prismaMock.creatorProfile.findUnique
         .mockResolvedValueOnce({ id: 'creator-1', deprecatedAt: null }) // creator lookup
         .mockResolvedValueOnce({ id: 'creator-2' }); // successor lookup

      await processKeyDeprecationEvents([
         makeEvent({ reason: 'sunset', successorKeyId: 'creator-2' }),
      ]);

      expect(prismaMock.creatorProfile.update).toHaveBeenCalledWith({
         where: { id: 'creator-1' },
         data: expect.objectContaining({
            reason: 'sunset',
            successorKeyId: 'creator-2',
         }),
      });
      expect(invalidateCreatorDashboardCache).toHaveBeenCalledWith(
         'creator-1'
      );
   });

   it('stores no successor when the referenced successor key does not exist', async () => {
      prismaMock.creatorProfile.findUnique
         .mockResolvedValueOnce({ id: 'creator-1', deprecatedAt: null })
         .mockResolvedValueOnce(null);

      await processKeyDeprecationEvents([
         makeEvent({ successorKeyId: 'missing-key' }),
      ]);

      expect(prismaMock.creatorProfile.update).toHaveBeenCalledWith({
         where: { id: 'creator-1' },
         data: expect.objectContaining({ successorKeyId: null }),
      });
   });

   it('is idempotent: replaying an already-deprecated key skips the write', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({
         id: 'creator-1',
         deprecatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await processKeyDeprecationEvents([makeEvent()]);

      expect(prismaMock.creatorProfile.update).not.toHaveBeenCalled();
      expect(invalidateCreatorDashboardCache).not.toHaveBeenCalled();
   });

   it('skips unknown creators without throwing', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValueOnce(null);

      await processKeyDeprecationEvents([makeEvent()]);

      expect(prismaMock.creatorProfile.update).not.toHaveBeenCalled();
   });

   it('ignores events of other types', async () => {
      await processKeyDeprecationEvents([
         {
            eventType: 'WHITELIST_ADDED',
            txHash: 'tx-2',
            eventIndex: 0,
         } as unknown as KeyDeprecationChainEvent,
      ]);

      expect(prismaMock.creatorProfile.findUnique).not.toHaveBeenCalled();
   });
});
