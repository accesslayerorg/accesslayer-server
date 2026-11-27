// src/modules/announcements/announcements.routes.ts

import { Router } from 'express';
import { requireCoCreatorPermission } from '../../middlewares/co-creator-permission.middleware';
import {
   httpCreateAnnouncement,
   httpUpdateAnnouncement,
   httpGetAnnouncement,
   httpListAnnouncements,
} from './announcements.controller';

/**
 * Router mounted at /announcements and /v1/announcements
 */
export const announcementsRouter = Router();

announcementsRouter.patch('/:id', httpUpdateAnnouncement);
announcementsRouter.get('/:id', httpGetAnnouncement);

/**
 * Router for key-specific announcement endpoints
 * Mounted in keys.routes.ts at /
 * Paths: /:keyId/announcements
 */
export const keyAnnouncementsRouter = Router();

keyAnnouncementsRouter.post(
   '/:keyId/announcements',
   requireCoCreatorPermission('CONTENT', 'keyId'),
   httpCreateAnnouncement
);

keyAnnouncementsRouter.get(
   '/:keyId/announcements',
   httpListAnnouncements
);

export default announcementsRouter;
