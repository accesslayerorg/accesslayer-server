import { Router } from 'express';
import { z } from 'zod';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { sendError, sendSuccess, sendValidationError, zodIssuesToDetails } from '../../utils/api-response.utils';
import { prisma } from '../../utils/prisma.utils';
import { getKeyLeaderboard } from '../keys/key-leaderboard.service';

const router = Router();
const querySchema = z.object({ metric: z.enum(['volume', 'holders', 'reputation']).default('volume'), limit: z.coerce.number().int().min(1).max(100).default(25) });

router.get('/keys/leaderboard', cacheControl({ maxAge: 300, type: 'public' }), async (req, res, next) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) { sendValidationError(res, 'Invalid leaderboard query', zodIssuesToDetails(parsed.error.issues)); return; }
  try {
    const { metric, limit } = parsed.data;
    const sortBy = metric === 'holders' ? 'holder_count' : 'volume_24h';
    const base = await getKeyLeaderboard(sortBy, 100);
    let ranked = base;
    let reputationScores = new Map<string, number>();
    if (metric === 'reputation') {
      const reputation = await prisma.creatorReputation.findMany({ where: { creatorId: { in: base.map(item => item.keyId) } }, select: { creatorId: true, currentScore: true } });
      reputationScores = new Map(reputation.map(row => [row.creatorId, row.currentScore]));
      ranked = [...base].sort((a, b) => (reputationScores.get(b.keyId) ?? 0) - (reputationScores.get(a.keyId) ?? 0));
    }
    sendSuccess(res, { items: ranked.slice(0, limit).map((entry, index) => ({ rank: index + 1, key_id: entry.keyId, key_name: entry.handle, creator: entry.creatorName, metric_value: metric === 'holders' ? entry.holder_count : metric === 'reputation' ? reputationScores.get(entry.keyId) ?? 0 : entry.volume_24h, '24h_change': entry.price_change })) });
  } catch (error) { next(error); }
});

export default router;
