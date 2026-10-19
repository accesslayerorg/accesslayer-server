import {
   processMilestoneClaimEvents,
   isMilestoneClaimEventType,
} from './holder-milestones-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import * as holderMilestonesService from '../milestones/holder-milestones.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      milestoneClaim: {
         upsert: jest.fn(),
      },
   },
}));

jest.mock('../milestones/holder-milestones.service', () => ({
   invalidateHolderMilestonesCache: jest.fn().mockResolvedValue(undefined),
}));

describe('holder-milestones-indexer.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('isMilestoneClaimEventType', () => {
      it('correctly identifies MilestoneRewardClaimed events', () => {
         expect(isMilestoneClaimEventType('MilestoneRewardClaimed')).toBe(true);
         expect(isMilestoneClaimEventType('MILESTONE_REWARD_CLAIMED')).toBe(true);
         expect(isMilestoneClaimEventType('KEY_BOUGHT')).toBe(false);
         expect(isMilestoneClaimEventType('OTHER_EVENT')).toBe(false);
      });
   });

   describe('processMilestoneClaimEvents', () => {
      it('upserts claim into milestone_claims table and invalidates cache', async () => {
         const now = new Date();
         const event = {
            eventType: 'MilestoneRewardClaimed',
            keyId: 'creator-key-1',
            wallet: 'wallet-holder-1',
            milestoneId: 'holding_30d',
            tier: 2,
            claimedAt: now.toISOString(),
            txHash: '0xclaim1',
            ledger: 5002,
            eventIndex: 0,
         };

         (prisma as any).milestoneClaim.upsert.mockResolvedValue({
            id: 'claim-1',
            keyId: 'creator-key-1',
            wallet: 'wallet-holder-1',
            milestoneId: 'holding_30d',
         });

         await processMilestoneClaimEvents([event as any]);

         expect((prisma as any).milestoneClaim.upsert).toHaveBeenCalledWith({
            where: {
               keyId_wallet_milestoneId: {
                  keyId: 'creator-key-1',
                  wallet: 'wallet-holder-1',
                  milestoneId: 'holding_30d',
               },
            },
            update: expect.objectContaining({
               tier: 2,
               txHash: '0xclaim1',
            }),
            create: expect.objectContaining({
               keyId: 'creator-key-1',
               wallet: 'wallet-holder-1',
               milestoneId: 'holding_30d',
               tier: 2,
               txHash: '0xclaim1',
            }),
         });

         expect(
            holderMilestonesService.invalidateHolderMilestonesCache
         ).toHaveBeenCalledWith('creator-key-1', 'wallet-holder-1');
      });

      it('gracefully handles missing keyId or wallet', async () => {
         const malformedEvent = {
            eventType: 'MilestoneRewardClaimed',
            txHash: '0xmalformed',
            eventIndex: 1,
         };

         await processMilestoneClaimEvents([malformedEvent as any]);
         expect((prisma as any).milestoneClaim.upsert).not.toHaveBeenCalled();
      });
   });
});
