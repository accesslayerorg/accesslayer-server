import { AsyncController } from '../../types/auth.types';
import { CreatorHoldersQuerySchema } from './creator-holders.schemas';
import {
   findCreatorByIdOrHandle,
   fetchCreatorHolders,
} from './creator-holders.service';
import {
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { parsePublicQuery } from '../../utils/public-query-parse.utils';
import { buildOffsetPaginationMeta } from '../../utils/pagination.utils';
import { handleCreatorParamNotFound } from '../creator/creator.utils';
import { parseCreatorId } from '../../utils/creator-id.utils';

/**
 * Controller for GET /api/v1/creators/:id/holders
 *
 * Returns a paginated list of wallets that hold keys for the given creator,
 * along with each wallet's current balance and the timestamp of their first buy.
 *
 * - Returns 404 if the creator does not exist.
 * - Returns an empty items array (not 404) if the creator exists but has no holders.
 * - Default sort: largest key_balance first.
 * - Optional ?sort=held_since returns earliest buyers first.
 */
export const httpGetCreatorHolders: AsyncController = async (req, res, next) => {
   try {
      const rawId = req.params.id;
      const creatorId = parseCreatorId(Array.isArray(rawId) ? rawId[0] : rawId);

      const parsed = parsePublicQuery(CreatorHoldersQuerySchema, req.query, {
         debugContext: 'creator-holders-query',
      });

      if (!parsed.ok) {
         return sendValidationError(res, 'Invalid query parameters', parsed.details);
      }

      const creator = await findCreatorByIdOrHandle(String(creatorId));
      if (!handleCreatorParamNotFound(res, creator)) return;

      const [holders, total] = await fetchCreatorHolders(creator.id, parsed.data);

      const meta = buildOffsetPaginationMeta({
         limit: parsed.data.limit,
         offset: parsed.data.offset,
         total,
      });

      attachTimestampHeader(res);
      sendSuccess(res, { items: holders, meta });
   } catch (error) {
      next(error);
   }
};