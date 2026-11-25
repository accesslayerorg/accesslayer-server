// src/modules/roadmap/roadmap.service.test.ts

jest.mock('../../utils/prisma.utils', () => {
   const mockTx = {
      roadmapMilestone: {
         findFirst: jest.fn(),
         findMany: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
      },
      outboxEvent: {
         create: jest.fn(),
      },
   };
   return {
      prisma: {
         creatorProfile: { findFirst: jest.fn() },
         roadmapMilestone: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
         },
         keyOwnership: { findFirst: jest.fn() },
         milestoneReaction: {
            findUnique: jest.fn(),
            create: jest.fn(),
         },
         $transaction: jest.fn(async (cb: any) => cb(mockTx)),
         __mockTx: mockTx,
      },
   };
});

jest.mock('../outbox/outbox.service', () => ({
   OutboxService: {
      enqueue: jest.fn(async () => 'outbox-1'),
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { OutboxService } from '../outbox/outbox.service';
import {
   getKeyRoadmap,
   createRoadmapMilestone,
   updateRoadmapMilestone,
   reorderRoadmapMilestones,
   addMilestoneReaction,
   isValidStatusTransition,
} from './roadmap.service';

const mockPrisma = prisma as any;
const mockTx = mockPrisma.__mockTx;

describe('roadmap.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({ id: 'key-1' });
   });

   it('validates milestone status transitions', () => {
      expect(isValidStatusTransition('PLANNED', 'IN_PROGRESS')).toBe(true);
      expect(isValidStatusTransition('PLANNED', 'DELAYED')).toBe(true);
      expect(isValidStatusTransition('IN_PROGRESS', 'COMPLETED')).toBe(true);
      expect(isValidStatusTransition('COMPLETED', 'IN_PROGRESS')).toBe(false);
      expect(isValidStatusTransition('CANCELLED', 'PLANNED')).toBe(false);
   });

   it('returns milestones ordered by position with reaction counts', async () => {
      mockPrisma.roadmapMilestone.findMany.mockResolvedValue([
         {
            id: 'm1',
            keyId: 'key-1',
            title: 'Alpha',
            position: 0,
            status: 'COMPLETED',
            reactions: [{ reaction: 'rocket' }, { reaction: 'rocket' }, { reaction: 'fire' }],
         },
      ]);

      const result = await getKeyRoadmap('key-1');
      expect(result).toHaveLength(1);
      expect(result[0].reactionCounts).toEqual({
         total: 3,
         byType: { rocket: 2, fire: 1 },
      });
   });

   it('creates milestone and emits roadmap.updated event', async () => {
      mockTx.roadmapMilestone.findFirst.mockResolvedValue({ position: 1 });
      mockTx.roadmapMilestone.create.mockResolvedValue({
         id: 'm2',
         keyId: 'key-1',
         title: 'Beta',
         status: 'PLANNED',
         position: 2,
         updatedAt: new Date('2026-11-24T12:00:00Z'),
      });

      const created = await createRoadmapMilestone({
         keyId: 'key-1',
         title: 'Beta',
      });

      expect(created.position).toBe(2);
      expect(OutboxService.enqueue).toHaveBeenCalledWith(
         mockTx,
         'roadmap.updated',
         expect.objectContaining({
            keyId: 'key-1',
            milestoneId: 'm2',
            action: 'created',
         })
      );
   });

   it('requires delayReason and revisedDate when transitioning to DELAYED', async () => {
      mockPrisma.roadmapMilestone.findUnique.mockResolvedValue({
         id: 'm1',
         keyId: 'key-1',
         status: 'IN_PROGRESS',
         delayReason: null,
         revisedDate: null,
         completedAt: null,
      });

      await expect(
         updateRoadmapMilestone({
            keyId: 'key-1',
            milestoneId: 'm1',
            status: 'DELAYED',
         })
      ).rejects.toMatchObject({
         statusCode: 400,
         code: 'DELAY_DETAILS_REQUIRED',
      });

      mockTx.roadmapMilestone.update.mockResolvedValue({
         id: 'm1',
         keyId: 'key-1',
         status: 'DELAYED',
         delayReason: 'Audit extended',
         revisedDate: new Date('2026-12-15T00:00:00Z'),
         updatedAt: new Date('2026-11-24T12:00:00Z'),
      });

      const updated = await updateRoadmapMilestone({
         keyId: 'key-1',
         milestoneId: 'm1',
         status: 'DELAYED',
         delayReason: 'Audit extended',
         revisedDate: '2026-12-15T00:00:00Z',
      });
      expect(updated.status).toBe('DELAYED');
      expect(updated.delayReason).toBe('Audit extended');
   });

   it('reorders milestones and emits roadmap.updated', async () => {
      mockPrisma.roadmapMilestone.findMany.mockResolvedValue([
         { id: 'm1' },
         { id: 'm2' },
      ]);
      mockTx.roadmapMilestone.findMany.mockResolvedValue([
         { id: 'm2', position: 0 },
         { id: 'm1', position: 1 },
      ]);

      const reordered = await reorderRoadmapMilestones({
         keyId: 'key-1',
         orderedIds: ['m2', 'm1'],
      });
      expect(reordered[0].id).toBe('m2');
      expect(OutboxService.enqueue).toHaveBeenCalledWith(
         mockTx,
         'roadmap.updated',
         expect.objectContaining({ action: 'reordered', orderedIds: ['m2', 'm1'] })
      );
   });

   it('enforces holder gating and single reaction per wallet per milestone', async () => {
      mockPrisma.roadmapMilestone.findUnique.mockResolvedValue({
         id: 'm1',
         keyId: 'key-1',
      });
      mockPrisma.keyOwnership.findFirst.mockResolvedValue(null);

      await expect(
         addMilestoneReaction({
            milestoneId: 'm1',
            walletAddress: 'GWALLET1',
            reaction: 'rocket',
         })
      ).rejects.toMatchObject({ statusCode: 403, code: 'HOLDER_REQUIRED' });

      mockPrisma.keyOwnership.findFirst.mockResolvedValue({ id: 'own-1' });
      mockPrisma.milestoneReaction.findUnique.mockResolvedValue({ id: 'react-1' });

      await expect(
         addMilestoneReaction({
            milestoneId: 'm1',
            walletAddress: 'GWALLET1',
            reaction: 'rocket',
         })
      ).rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_REACTED' });

      mockPrisma.milestoneReaction.findUnique.mockResolvedValue(null);
      mockPrisma.milestoneReaction.create.mockResolvedValue({
         id: 'react-2',
         milestoneId: 'm1',
         walletAddress: 'GWALLET1',
         reaction: 'rocket',
      });

      const created = await addMilestoneReaction({
         milestoneId: 'm1',
         walletAddress: 'GWALLET1',
         reaction: 'rocket',
      });
      expect(created.reaction).toBe('rocket');
   });
});
