// src/modules/announcements/announcements.service.ts

import EventEmitter from 'events';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { emitAuditEvent } from '../../utils/audit.utils';
import { checkCreatorProfileOwnership } from '../../utils/wallet-ownership.utils';
import { getCoCreatorDetail } from '../co-creators/co-creators.service';
import {
   AnnouncementStatus,
   CreateAnnouncementInput,
   UpdateAnnouncementInput,
   SerializedAnnouncement,
   AnnouncementPublishedEvent,
} from './announcements.types';

export const announcementEventEmitter = new EventEmitter();

export const MIN_SCHEDULE_LEAD_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_SCHEDULE_HORIZON_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export class AnnouncementValidationError extends Error {
   public readonly statusCode: number = 400;
   constructor(message: string) {
      super(message);
      this.name = 'AnnouncementValidationError';
   }
}

export class AnnouncementNotFoundError extends Error {
   public readonly statusCode: number = 404;
   constructor(message = 'Announcement not found') {
      super(message);
      this.name = 'AnnouncementNotFoundError';
   }
}

export class AnnouncementForbiddenError extends Error {
   public readonly statusCode: number = 403;
   constructor(message = 'Access denied. You must be the key creator or an active co-creator.') {
      super(message);
      this.name = 'AnnouncementForbiddenError';
   }
}

export class AnnouncementInvalidStatusError extends Error {
   public readonly statusCode: number = 400;
   constructor(message = 'Announcement can only be edited or cancelled while scheduled') {
      super(message);
      this.name = 'AnnouncementInvalidStatusError';
   }
}

/**
 * Validates that scheduledAt is at least 5 minutes and at most 90 days ahead.
 */
export function validateScheduledAt(
   scheduledAt: string | Date,
   now: number = Date.now()
): Date {
   const date = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
   const time = date.getTime();

   if (isNaN(time)) {
      throw new AnnouncementValidationError('Invalid scheduledAt timestamp format');
   }

   const minTime = now + MIN_SCHEDULE_LEAD_MS;
   const maxTime = now + MAX_SCHEDULE_HORIZON_MS;

   if (time < minTime || time > maxTime) {
      throw new AnnouncementValidationError(
         'scheduledAt must be at least 5 minutes and at most 90 days ahead'
      );
   }

   return date;
}

/**
 * Verifies that the given wallet is either the primary creator of the key or an active
 * co-creator with ADMIN or CONTENT role.
 */
export async function verifyKeyCreatorOrCoCreator(
   wallet: string,
   keyId: string
): Promise<boolean> {
   if (!wallet || !keyId) {
      return false;
   }

   // 1. Primary creator check
   try {
      const ownershipVerdict = await checkCreatorProfileOwnership(wallet, keyId);
      if (ownershipVerdict.status === 'granted') {
         return true;
      }
   } catch (error) {
      logger.debug({ error, wallet, keyId }, 'Creator ownership check threw error');
   }

   // 2. Active co-creator check
   try {
      const detail = await getCoCreatorDetail(keyId, wallet);
      if (detail && detail.active) {
         const upperRole = detail.role?.toUpperCase();
         if (upperRole === 'ADMIN' || upperRole === 'CONTENT') {
            return true;
         }
      }
   } catch (error) {
      logger.debug({ error, wallet, keyId }, 'Co-creator check threw error');
   }

   return false;
}

/**
 * Resolves a key identifier (ID or handle) to canonical creator ID.
 */
export async function resolveCreatorKeyId(keyIdOrHandle: string): Promise<string> {
   try {
      const creator = await prisma.creatorProfile.findFirst({
         where: {
            OR: [{ id: keyIdOrHandle }, { handle: keyIdOrHandle }],
         },
         select: { id: true },
      });
      return creator?.id ?? keyIdOrHandle;
   } catch {
      return keyIdOrHandle;
   }
}

export function serializeAnnouncement(announcement: any): SerializedAnnouncement {
   const scheduledAt = announcement.scheduledAt
      ? new Date(announcement.scheduledAt).toISOString()
      : null;
   const publishedAt = announcement.publishedAt
      ? new Date(announcement.publishedAt).toISOString()
      : null;
   const createdAt = announcement.createdAt
      ? new Date(announcement.createdAt).toISOString()
      : new Date().toISOString();
   const updatedAt = announcement.updatedAt
      ? new Date(announcement.updatedAt).toISOString()
      : new Date().toISOString();

   return {
      id: announcement.id,
      keyId: announcement.keyId,
      key_id: announcement.keyId,
      content: announcement.content,
      status: String(announcement.status),
      scheduledAt,
      scheduled_at: scheduledAt,
      publishedAt,
      published_at: publishedAt,
      createdAt,
      created_at: createdAt,
      updatedAt,
      updated_at: updatedAt,
   };
}

/**
 * Creates a new announcement.
 * If scheduledAt is provided, it is scheduled for future publishing.
 * Otherwise, it is published immediately.
 */
export async function createAnnouncement(
   keyId: string,
   input: CreateAnnouncementInput,
   wallet?: string
): Promise<SerializedAnnouncement> {
   if (!input.content || typeof input.content !== 'string' || !input.content.trim()) {
      throw new AnnouncementValidationError('Announcement content is required');
   }

   const resolvedKeyId = await resolveCreatorKeyId(keyId);
   const trimmedContent = input.content.trim();
   const now = new Date();

   let scheduledDate: Date | null = null;
   let status: AnnouncementStatus;
   let publishedAt: Date | null = null;

   if (input.scheduledAt) {
      scheduledDate = validateScheduledAt(input.scheduledAt, now.getTime());
      status = AnnouncementStatus.scheduled;
   } else if (input.status === 'draft' || input.status === AnnouncementStatus.draft) {
      status = AnnouncementStatus.draft;
   } else {
      status = AnnouncementStatus.published;
      publishedAt = now;
   }

   const created = await prisma.announcement.create({
      data: {
         keyId: resolvedKeyId,
         content: trimmedContent,
         scheduledAt: scheduledDate,
         status,
         publishedAt,
      },
   });

   if (status === AnnouncementStatus.published) {
      const eventPayload: AnnouncementPublishedEvent = {
         id: created.id,
         keyId: created.keyId,
         content: created.content,
         status: 'published',
         publishedAt: now,
      };
      announcementEventEmitter.emit('announcement.published', eventPayload);

      void emitAuditEvent({
         actor: wallet || 'system',
         action: 'announcement.published',
         target: 'announcement',
         targetId: created.id,
         metadata: { keyId: created.keyId },
      }).catch(() => {});
   }

   return serializeAnnouncement(created);
}

/**
 * Updates or cancels an existing scheduled announcement.
 * Only allowed when current status is scheduled.
 */
export async function updateAnnouncement(
   id: string,
   input: UpdateAnnouncementInput,
   wallet?: string
): Promise<SerializedAnnouncement> {
   const existing = await prisma.announcement.findUnique({
      where: { id },
   });

   if (!existing) {
      throw new AnnouncementNotFoundError();
   }

   // Verify permissions
   if (wallet) {
      const hasPermission = await verifyKeyCreatorOrCoCreator(wallet, existing.keyId);
      if (!hasPermission) {
         throw new AnnouncementForbiddenError();
      }
   }

   // Can only edit or cancel while status is scheduled
   if (existing.status !== AnnouncementStatus.scheduled) {
      throw new AnnouncementInvalidStatusError(
         `Announcement can only be edited or cancelled while scheduled (current status: ${existing.status})`
      );
   }

   const updateData: {
      content?: string;
      scheduledAt?: Date;
      status?: AnnouncementStatus;
   } = {};

   // Check cancellation
   if (
      input.status === AnnouncementStatus.cancelled ||
      input.action === 'cancel' ||
      input.cancel === true
   ) {
      updateData.status = AnnouncementStatus.cancelled;
   } else if (input.status && input.status !== AnnouncementStatus.scheduled) {
      throw new AnnouncementValidationError(`Invalid status update: ${input.status}`);
   }

   // Check content edit
   if (input.content !== undefined) {
      if (typeof input.content !== 'string' || !input.content.trim()) {
         throw new AnnouncementValidationError('Announcement content cannot be empty');
      }
      updateData.content = input.content.trim();
   }

   // Check scheduledAt edit
   if (input.scheduledAt !== undefined && input.scheduledAt !== null) {
      updateData.scheduledAt = validateScheduledAt(input.scheduledAt);
   }

   const updated = await prisma.announcement.update({
      where: { id },
      data: updateData,
   });

   if (updateData.status === AnnouncementStatus.cancelled) {
      void emitAuditEvent({
         actor: wallet || 'system',
         action: 'announcement.cancelled',
         target: 'announcement',
         targetId: updated.id,
         metadata: { keyId: updated.keyId },
      }).catch(() => {});
   }

   return serializeAnnouncement(updated);
}

/**
 * Retrieves a single announcement by ID.
 */
export async function getAnnouncement(id: string): Promise<SerializedAnnouncement> {
   const announcement = await prisma.announcement.findUnique({
      where: { id },
   });

   if (!announcement) {
      throw new AnnouncementNotFoundError();
   }

   return serializeAnnouncement(announcement);
}

/**
 * Lists announcements for a given key ID.
 */
export async function listAnnouncements(
   keyId: string,
   statusFilter?: string
): Promise<SerializedAnnouncement[]> {
   const resolvedKeyId = await resolveCreatorKeyId(keyId);
   const where: Record<string, any> = { keyId: resolvedKeyId };

   if (statusFilter) {
      where.status = statusFilter;
   }

   const announcements = await prisma.announcement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
   });

   return announcements.map(serializeAnnouncement);
}
