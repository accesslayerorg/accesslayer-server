// src/modules/keys/launches.routes.ts
import { Router } from 'express';
import { prisma } from '../../utils/prisma.utils';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';
import { classifyLaunchPhase, LaunchPhase } from './key-launch-auction.service';

const launchesRouter = Router();
const VALID_TABS = new Set<LaunchPhase>(['upcoming', 'live', 'recent']);

/**
 * GET /v1/launches?tab=upcoming|live|recent (#1328, minimal first pass).
 *
 * Derives the tab from indexed KeyLaunchAuction records; full calendar
 * grouping, reminders and cursor pagination are out of scope for this pass.
 */
launchesRouter.get('/', async (req, res) => {
   const tab = String(req.query.tab ?? 'upcoming') as LaunchPhase;
   if (!VALID_TABS.has(tab)) {
      sendValidationError(res, 'Invalid tab', [
         { field: 'tab', message: 'must be upcoming, live or recent' },
      ]);
      return;
   }
   const now = new Date();
   const auctions = await prisma.keyLaunchAuction.findMany({
      orderBy: { startsAt: 'asc' },
      take: 100,
   });
   const items = auctions.filter(a => classifyLaunchPhase(a, now) === tab);
   sendSuccess(res, { tab, items });
});

export default launchesRouter;
