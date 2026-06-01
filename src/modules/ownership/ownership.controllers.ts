import { AsyncController } from '../../types/auth.types';
import { OwnershipQuerySchema } from './ownership.schemas';
import { fetchOwnership } from './ownership.service';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';

export const httpGetOwnership: AsyncController = async (req, res, next) => {
    try {
        const parsed = OwnershipQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return sendValidationError(res, 'Invalid query parameters', parsed.error.issues.map(issue => ({
                field: issue.path.join('.'),
                message: issue.message,
            })));
        }

        const ownership = await fetchOwnership(parsed.data);
        sendSuccess(res, ownership);
    } catch (error) {
        next(error);
    }
};
