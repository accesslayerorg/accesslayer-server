import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { invalidateCreatorDashboardCache } from '../creator/creator-dashboard.service';
import { invalidateKeyAnalyticsCache } from './key-analytics.service';
import { KeyNotFoundError } from './key-fees.service';
import { creatorProfileExists } from '../creator/creator-profile.service';
import { cacheInvalidate } from '../../utils/redis.utils';

export interface CurveResetEventPayload {
   creatorId: string;
   ledger: number;
   txHash: string;
   timestamp: Date;
   configDiff?: Record<string, unknown>;
}

export async function processCurveResetEvent(event: CurveResetEventPayload) {
   if (!(await creatorProfileExists(event.creatorId))) {
      throw new KeyNotFoundError(`Key ${event.creatorId} not found`);
   }

   const relaunch = await prisma.creatorKeyRelaunch.create({
      data: {
         creatorId: event.creatorId,
         ledger: event.ledger,
         txHash: event.txHash,
         timestamp: event.timestamp,
         configDiff: event.configDiff as any,
      },
   });

   await prisma.creatorProfile.update({
      where: { id: event.creatorId },
      data: { relaunchCount: { increment: 1 } },
   });

   try {
      await invalidateCreatorDashboardCache(event.creatorId);
   } catch {
      // non-critical
   }

   try {
      await invalidateKeyAnalyticsCache(event.creatorId);
   } catch {
      // non-critical
   }

   try {
      await cacheInvalidate(`key:metadata:${event.creatorId}`);
   } catch {
      // non-critical
   }

   logger.warn(
      {
         type: 'admin_alert',
         creatorId: event.creatorId,
         relaunchId: relaunch.id,
      },
      `ADMIN ALERT: Creator key ${event.creatorId} bonding curve relaunched`
   );

   return relaunch;
}

export async function getKeyRelaunchHistory(keyId: string) {
   if (!(await creatorProfileExists(keyId))) {
      throw new KeyNotFoundError(`Key ${keyId} not found`);
   }

   const relaunches = await prisma.creatorKeyRelaunch.findMany({
      where: { creatorId: keyId },
      orderBy: { timestamp: 'desc' },
      select: {
         id: true,
         ledger: true,
         txHash: true,
         timestamp: true,
         configDiff: true,
      },
   });

   return relaunches.map((r) => ({
      ...r,
      timestamp: r.timestamp.toISOString(),
   }));
}
