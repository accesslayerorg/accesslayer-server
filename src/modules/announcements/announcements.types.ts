// src/modules/announcements/announcements.types.ts

export const AnnouncementStatus = {
   draft: 'draft',
   scheduled: 'scheduled',
   published: 'published',
   cancelled: 'cancelled',
} as const;

export type AnnouncementStatus =
   (typeof AnnouncementStatus)[keyof typeof AnnouncementStatus];

export interface CreateAnnouncementInput {
   content: string;
   scheduledAt?: string | Date | null;
   status?: AnnouncementStatus | string;
}

export interface UpdateAnnouncementInput {
   content?: string;
   scheduledAt?: string | Date;
   status?: AnnouncementStatus | string;
   action?: 'cancel' | string;
   cancel?: boolean;
}

export interface SerializedAnnouncement {
   id: string;
   keyId: string;
   key_id: string;
   content: string;
   status: string;
   scheduledAt: string | null;
   scheduled_at: string | null;
   publishedAt: string | null;
   published_at: string | null;
   createdAt: string;
   created_at: string;
   updatedAt: string;
   updated_at: string;
}

export interface AnnouncementPublishedEvent {
   id: string;
   keyId: string;
   content: string;
   status: 'published';
   publishedAt: Date;
}
