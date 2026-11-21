// src/modules/notifications/notification.controllers.ts
import { Request, Response, NextFunction } from 'express';
import { sendSuccess, sendUnauthorized } from '../../utils/api-response.utils';
import {
   listNotifications,
   markAllNotificationsRead,
} from './notification.service';

export async function httpListNotifications(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const walletAddress = req.jwtPayload?.walletAddress;
      if (!walletAddress) {
         sendUnauthorized(res);
         return;
      }

      const notifications = await listNotifications(walletAddress);
      sendSuccess(res, { items: notifications, total: notifications.length });
   } catch (error) {
      next(error);
   }
}

export async function httpMarkAllNotificationsRead(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const walletAddress = req.jwtPayload?.walletAddress;
      if (!walletAddress) {
         sendUnauthorized(res);
         return;
      }

      await markAllNotificationsRead(walletAddress);
      res.status(204).send();
   } catch (error) {
      next(error);
   }
}
