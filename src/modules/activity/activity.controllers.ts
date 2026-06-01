import { AsyncController } from '../../types/auth.types';
import { ActivityQuerySchema } from './activity.schemas';
import { fetchActivityFeed } from './activity.service';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';
import { buildOffsetPaginationMeta } from '../../utils/pagination.utils';

export const httpGetActivityFeed: AsyncController = async (req, res, next) => {
    try {
        const parsed = ActivityQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return sendValidationError(res, 'Invalid query parameters', parsed.error.issues.map(issue => ({
                field: issue.path.join('.'),
                message: issue.message,
            })));
        }

        const [items, total] = await fetchActivityFeed(parsed.data);

        const response = {
            items,
            meta: buildOffsetPaginationMeta({
                limit: parsed.data.limit,
                offset: parsed.data.offset,
                total,
            }),
        };

        sendSuccess(res, response);
    } catch (error) {
        next(error);
    }
};
