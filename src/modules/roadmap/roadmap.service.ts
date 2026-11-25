// src/modules/roadmap/roadmap.service.ts
// Creator roadmap milestones, status transition validation, holder-gated reactions,
// and roadmap.updated outbox notifications (#1310).

import { prisma } from '../../utils/prisma.utils';
import { OutboxService } from '../outbox/outbox.service';

export type MilestoneStatus =
   | 'PLANNED'
   | 'IN_PROGRESS'
   | 'DELAYED'
   | 'COMPLETED'
   | 'CANCELLED';

const ALLOWED_TRANSITIONS: Record<MilestoneStatus, MilestoneStatus[]> = {
   PLANNED: ['IN_PROGRESS', 'DELAYED', 'COMPLETED', 'CANCELLED'],
   IN_PROGRESS: ['DELAYED', 'COMPLETED', 'CANCELLED'],
   DELAYED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
   COMPLETED: [],
   CANCELLED: [],
};

export class RoadmapServiceError extends Error {
   statusCode: number;
   code: string;

   constructor(statusCode: number, code: string, message: string) {
      super(message);
      this.name = 'RoadmapServiceError';
      this.statusCode = statusCode;
      this.code = code;
   }
}

export function isValidStatusTransition(
   from: MilestoneStatus,
   to: MilestoneStatus
): boolean {
   if (from === to) return true;
   return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

async function resolveKeyId(keyIdOrHandle: string): Promise<string> {
   const profile = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyIdOrHandle }, { handle: keyIdOrHandle }] },
      select: { id: true },
   });
   return profile?.id ?? keyIdOrHandle;
}

function summarizeReactions(reactions: Array<{ reaction: string }>) {
   const byType: Record<string, number> = {};
   for (const r of reactions) {
      byType[r.reaction] = (byType[r.reaction] ?? 0) + 1;
   }
   return {
      total: reactions.length,
      byType,
   };
}

/**
 * Lists milestones for a key ordered by position ascending, including reaction counts.
 */
export async function getKeyRoadmap(keyIdOrHandle: string) {
   const keyId = await resolveKeyId(keyIdOrHandle);
   const milestones = await prisma.roadmapMilestone.findMany({
      where: { keyId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: {
         reactions: {
            select: { reaction: true },
         },
      },
   });

   return milestones.map(({ reactions, ...milestone }) => ({
      ...milestone,
      reactionCounts: summarizeReactions(reactions),
   }));
}

/**
 * Creates a new roadmap milestone for a key and emits `roadmap.updated`.
 */
export async function createRoadmapMilestone(input: {
   keyId: string;
   title: string;
   description?: string;
   status?: MilestoneStatus;
   position?: number;
   targetDate?: string;
   revisedDate?: string;
   delayReason?: string;
}) {
   const keyId = await resolveKeyId(input.keyId);
   const status: MilestoneStatus = input.status ?? 'PLANNED';

   if (status === 'DELAYED' && (!input.delayReason || !input.revisedDate)) {
      throw new RoadmapServiceError(
         400,
         'DELAY_DETAILS_REQUIRED',
         'delayReason and revisedDate are required when status is DELAYED'
      );
   }

   return prisma.$transaction(async tx => {
      let position = input.position;
      if (position === undefined) {
         const last = await tx.roadmapMilestone.findFirst({
            where: { keyId },
            orderBy: { position: 'desc' },
            select: { position: true },
         });
         position = last ? last.position + 1 : 0;
      }

      const milestone = await tx.roadmapMilestone.create({
         data: {
            keyId,
            title: input.title,
            description: input.description,
            status,
            position,
            targetDate: input.targetDate ? new Date(input.targetDate) : null,
            revisedDate: input.revisedDate ? new Date(input.revisedDate) : null,
            delayReason: input.delayReason ?? null,
            completedAt: status === 'COMPLETED' ? new Date() : null,
         },
      });

      await OutboxService.enqueue(tx as unknown as typeof prisma, 'roadmap.updated', {
         keyId,
         milestoneId: milestone.id,
         action: 'created',
         status: milestone.status,
         updatedAt: milestone.updatedAt.toISOString(),
      });

      return milestone;
   });
}

/**
 * Updates a roadmap milestone, validating status transitions, recording delay
 * reasons & revised dates when delayed, and emitting `roadmap.updated`.
 */
export async function updateRoadmapMilestone(input: {
   keyId: string;
   milestoneId: string;
   title?: string;
   description?: string;
   status?: MilestoneStatus;
   targetDate?: string | null;
   revisedDate?: string | null;
   delayReason?: string | null;
}) {
   const keyId = await resolveKeyId(input.keyId);
   const existing = await prisma.roadmapMilestone.findUnique({
      where: { id: input.milestoneId },
   });
   if (!existing || existing.keyId !== keyId) {
      throw new RoadmapServiceError(
         404,
         'MILESTONE_NOT_FOUND',
         'Roadmap milestone not found'
      );
   }

   const nextStatus = (input.status ?? existing.status) as MilestoneStatus;
   if (!isValidStatusTransition(existing.status as MilestoneStatus, nextStatus)) {
      throw new RoadmapServiceError(
         400,
         'INVALID_STATUS_TRANSITION',
         `Cannot transition milestone from ${existing.status} to ${nextStatus}`
      );
   }

   const becomingDelayed = nextStatus === 'DELAYED' && existing.status !== 'DELAYED';
   const effectiveReason = input.delayReason ?? existing.delayReason;
   const effectiveRevisedDate =
      input.revisedDate !== undefined
         ? input.revisedDate
         : existing.revisedDate?.toISOString();

   if (becomingDelayed && (!effectiveReason || !effectiveRevisedDate)) {
      throw new RoadmapServiceError(
         400,
         'DELAY_DETAILS_REQUIRED',
         'delayReason and revisedDate are required when transitioning to DELAYED'
      );
   }

   return prisma.$transaction(async tx => {
      const updated = await tx.roadmapMilestone.update({
         where: { id: existing.id },
         data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined
               ? { description: input.description }
               : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.targetDate !== undefined
               ? { targetDate: input.targetDate ? new Date(input.targetDate) : null }
               : {}),
            ...(input.revisedDate !== undefined
               ? { revisedDate: input.revisedDate ? new Date(input.revisedDate) : null }
               : {}),
            ...(input.delayReason !== undefined
               ? { delayReason: input.delayReason }
               : {}),
            ...(nextStatus === 'COMPLETED' && !existing.completedAt
               ? { completedAt: new Date() }
               : {}),
         },
      });

      await OutboxService.enqueue(tx as unknown as typeof prisma, 'roadmap.updated', {
         keyId,
         milestoneId: updated.id,
         action: 'updated',
         status: updated.status,
         delayReason: updated.delayReason,
         revisedDate: updated.revisedDate?.toISOString() ?? null,
         updatedAt: updated.updatedAt.toISOString(),
      });

      return updated;
   });
}

/**
 * Reorders milestones for a key according to `orderedIds` and emits `roadmap.updated`.
 */
export async function reorderRoadmapMilestones(input: {
   keyId: string;
   orderedIds: string[];
}) {
   const keyId = await resolveKeyId(input.keyId);
   const existing = await prisma.roadmapMilestone.findMany({
      where: { keyId },
      select: { id: true },
   });
   const existingIds = new Set(existing.map(m => m.id));

   for (const id of input.orderedIds) {
      if (!existingIds.has(id)) {
         throw new RoadmapServiceError(
            400,
            'INVALID_MILESTONE_ORDER',
            `Milestone ${id} does not belong to key ${keyId}`
         );
      }
   }

   return prisma.$transaction(async tx => {
      for (let index = 0; index < input.orderedIds.length; index++) {
         await tx.roadmapMilestone.update({
            where: { id: input.orderedIds[index] },
            data: { position: index },
         });
      }

      await OutboxService.enqueue(tx as unknown as typeof prisma, 'roadmap.updated', {
         keyId,
         action: 'reordered',
         orderedIds: input.orderedIds,
         updatedAt: new Date().toISOString(),
      });

      return tx.roadmapMilestone.findMany({
         where: { keyId },
         orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      });
   });
}

/**
 * Adds a holder-gated reaction to a milestone (one reaction per wallet per milestone).
 */
export async function addMilestoneReaction(input: {
   milestoneId: string;
   walletAddress: string;
   reaction: string;
}) {
   const milestone = await prisma.roadmapMilestone.findUnique({
      where: { id: input.milestoneId },
      select: { id: true, keyId: true },
   });
   if (!milestone) {
      throw new RoadmapServiceError(
         404,
         'MILESTONE_NOT_FOUND',
         'Roadmap milestone not found'
      );
   }

   const holding = await prisma.keyOwnership.findFirst({
      where: {
         ownerAddress: input.walletAddress,
         creatorId: milestone.keyId,
         balance: { gt: 0 },
      },
      select: { id: true },
   });
   if (!holding) {
      throw new RoadmapServiceError(
         403,
         'HOLDER_REQUIRED',
         'Only wallets holding this key may react to milestones'
      );
   }

   const existing = await prisma.milestoneReaction.findUnique({
      where: {
         milestoneId_walletAddress: {
            milestoneId: input.milestoneId,
            walletAddress: input.walletAddress,
         },
      },
      select: { id: true },
   });
   if (existing) {
      throw new RoadmapServiceError(
         409,
         'ALREADY_REACTED',
         'Wallet has already reacted to this milestone'
      );
   }

   return prisma.milestoneReaction.create({
      data: {
         milestoneId: input.milestoneId,
         walletAddress: input.walletAddress,
         reaction: input.reaction,
      },
   });
}
