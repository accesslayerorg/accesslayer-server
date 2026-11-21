// src/modules/notifications/notification.types.ts
import { NotificationType } from '../../constants/notifications.constants';

export type NotificationItem = {
   id: string;
   type: NotificationType;
   createdAt: string;
   read: boolean;
   payload: Record<string, unknown>;
};
