import { AsyncController } from '../../types/auth.types';
import { getVolumeLeaderboard } from './creator-leaderboard-volume.service';
import { sendSuccess } from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';

/**
 * Controller for GET /api/v1/creators/leaderboard/volume
 *
 * Returns the top 20 creator keys ranked by total trading volume (buys +
 * sells) over a rolling window, cached in Redis for a short TTL.
 */
export const httpGetVolumeLeaderboard: AsyncController = async (
   _req,
   res,
   next
) => {
   try {
      const items = await getVolumeLeaderboard();
      attachTimestampHeader(res);
      sendSuccess(res, { items });
   } catch (error) {
      next(error);
   }
};
