// src/modules/indexer/persist-circulating-supply.service.test.ts
import { persistCirculatingSupply } from './persist-circulating-supply.service';

jest.mock('../../utils/prisma.utils', () => {
   const mockTx = {
      activity: {
         findMany: jest.fn(),
         create: jest.fn(),
      },
      creatorProfile: {
         findUnique: jest.fn(),
         update: jest.fn(),
      },
   };
   return {
      prisma: {
         $transaction: jest.fn(callback => callback(mockTx)),
      },
      _mockTx: mockTx,
   };
});

describe('persistCirculatingSupply', () => {
   const { _mockTx } = jest.requireMock('../../utils/prisma.utils');

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('calculates supply and updates creatorProfile without milestone change', async () => {
      _mockTx.activity.findMany.mockResolvedValue([
         { type: 'KEY_BOUGHT', payload: { amount: 5 } },
         { type: 'KEY_SOLD', payload: { amount: 2 } },
      ]);
      _mockTx.creatorProfile.findUnique.mockResolvedValue({
         currentMilestone: 0,
      });

      await persistCirculatingSupply('creator-1');

      // 5 bought - 2 sold = 3 supply
      expect(_mockTx.creatorProfile.update).toHaveBeenCalledWith({
         where: { id: 'creator-1' },
         data: { circulatingSupply: 3, currentMilestone: 0 },
      });
      expect(_mockTx.activity.create).not.toHaveBeenCalled();
   });

   it('detects upward milestone crossing and emits event', async () => {
      _mockTx.activity.findMany.mockResolvedValue([
         { type: 'KEY_BOUGHT', payload: { amount: 15 } }, // Supply = 15 -> Tier 1 (threshold 10)
      ]);
      _mockTx.creatorProfile.findUnique.mockResolvedValue({
         currentMilestone: 0,
      });

      await persistCirculatingSupply('creator-1');

      expect(_mockTx.creatorProfile.update).toHaveBeenCalledWith({
         where: { id: 'creator-1' },
         data: { circulatingSupply: 15, currentMilestone: 1 },
      });

      expect(_mockTx.activity.create).toHaveBeenCalledWith({
         data: {
            type: 'MILESTONE_CROSSED',
            actor: 'system',
            creatorId: 'creator-1',
            payload: {
               keyId: 'creator-1',
               milestoneTier: 1,
               oldMilestone: 0,
               newMilestone: 1,
               supply: 15,
               direction: 'up',
            },
         },
      });
   });

   it('detects downward milestone crossing and emits event', async () => {
      _mockTx.activity.findMany.mockResolvedValue([
         { type: 'KEY_BOUGHT', payload: { amount: 5 } }, // Supply = 5 -> Tier 0
      ]);
      _mockTx.creatorProfile.findUnique.mockResolvedValue({
         currentMilestone: 1, // Start with milestone 1 (crossed boundary downwards)
      });

      await persistCirculatingSupply('creator-1');

      expect(_mockTx.creatorProfile.update).toHaveBeenCalledWith({
         where: { id: 'creator-1' },
         data: { circulatingSupply: 5, currentMilestone: 0 },
      });

      expect(_mockTx.activity.create).toHaveBeenCalledWith({
         data: {
            type: 'MILESTONE_CROSSED',
            actor: 'system',
            creatorId: 'creator-1',
            payload: {
               keyId: 'creator-1',
               milestoneTier: 0,
               oldMilestone: 1,
               newMilestone: 0,
               supply: 5,
               direction: 'down',
            },
         },
      });
   });
});
