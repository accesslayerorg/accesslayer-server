// src/modules/notifications/notification.routes.ts
import { Router } from 'express';
import { jwtAuth } from '../../middlewares/jwt.middleware';
import {
   httpListNotifications,
   httpMarkAllNotificationsRead,
} from './notification.controllers';
import {
   httpVerifyNotificationEmail,
   httpUnsubscribeNotificationDigest,
} from './notification-preference.controllers';

const notificationsRouter = Router();

notificationsRouter.get('/verify', httpVerifyNotificationEmail);
notificationsRouter.get('/unsubscribe', httpUnsubscribeNotificationDigest);
notificationsRouter.get('/', jwtAuth, httpListNotifications);
notificationsRouter.post('/read-all', jwtAuth, httpMarkAllNotificationsRead);

export default notificationsRouter;
