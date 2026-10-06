import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendError,
} from '../../utils/api-response.utils';
import {
   getDiscovery,
   getLeaderboard,
   searchAll,
   type SearchType,
} from './keys-discovery.service';

const LEADERBOARD_WINDOWS = ['24h', '7d', '30d'] as const;
type LeaderboardWindow = (typeof LEADERBOARD_WINDOWS)[number];

const SEARCH_TYPES = ['keys', 'creators', 'proposals'] as const;

function parseLimit(raw: unknown, fallback: number, max: number): number {
   const n = Number(raw);
   if (!Number.isFinite(n) || n <= 0) return fallback;
   return Math.min(Math.floor(n), max);
}

/**
 * GET /api/v1/keys/discovery (issue #901)
 *
 * Trending keys by 24h volume (top 5) plus the 10 newest listings. Cached
 * for 60s and invalidated on new key creation. Both sections always render,
 * even with zero volume.
 */
export const httpGetKeyDiscovery: AsyncController = async (_req, res, next) => {
   try {
      const body = await getDiscovery();
      sendSuccess(res, body, 200, 'Key discovery retrieved successfully');
   } catch (error) {
      next(error);
   }
};

/**
 * GET /api/v1/keys/leaderboard (issue #896)
 *
 * Trading volume aggregated per creator key over ?window= (24h default,
 * 7d, 30d), ranked descending, ?limit= capped at 50. Cached with a TTL
 * matching the window.
 */
export const httpGetKeyLeaderboard: AsyncController = async (req, res, next) => {
   try {
      const rawWindow = String(req.query.window ?? '24h');
      if (!LEADERBOARD_WINDOWS.includes(rawWindow as LeaderboardWindow)) {
         return sendError(
            res,
            400,
            'VALIDATION_ERROR',
            `Invalid window "${rawWindow}". Supported: ${LEADERBOARD_WINDOWS.join(', ')}`
         );
      }
      const limit = parseLimit(req.query.limit, 10, 50);
      const body = await getLeaderboard(rawWindow as LeaderboardWindow, limit);
      sendSuccess(res, body, 200, 'Key leaderboard retrieved successfully');
   } catch (error) {
      next(error);
   }
};

/**
 * GET /api/v1/search (issue #895)
 *
 * Unified search across creator keys, creator profiles and governance
 * proposals, ranked by text-match relevance. ?type= restricts the result
 * set; an empty ?q= is a 400 with usage guidance.
 */
export const httpGlobalSearch: AsyncController = async (req, res, next) => {
   try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (!q) {
         return sendError(
            res,
            400,
            'VALIDATION_ERROR',
            'Missing query. Usage: GET /api/v1/search?q=<term>[&type=keys,creators,proposals]'
         );
      }

      const rawTypes = String(req.query.type ?? '').trim();
      let types: SearchType[];
      if (!rawTypes) {
         types = [...SEARCH_TYPES];
      } else {
         const requested = rawTypes.split(',').map((t) => t.trim());
         const invalid = requested.filter(
            (t) => !SEARCH_TYPES.includes(t as SearchType)
         );
         if (invalid.length > 0) {
            return sendError(
               res,
               400,
               'VALIDATION_ERROR',
               `Invalid type "${invalid[0]}". Supported: ${SEARCH_TYPES.join(', ')}`
            );
         }
         types = requested as SearchType[];
      }

      const body = await searchAll(q, types);
      sendSuccess(res, body, 200, 'Search results retrieved successfully');
   } catch (error) {
      next(error);
   }
};
