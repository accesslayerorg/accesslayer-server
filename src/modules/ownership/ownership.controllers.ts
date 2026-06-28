import { AsyncController } from '../../types/auth.types';
import { OwnershipQuerySchema } from './ownership.schemas';
import { fetchOwnership } from './ownership.service';
import { calculateTotalPortfolioValue } from './ownership.utils';
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

        const records = await fetchOwnership(parsed.data);
        const holdings = records.map(record => ({
            id: record.id,
            ownerAddress: record.ownerAddress,
            creatorId: record.creatorId,
            balance: record.balance.toString(),
            currentPrice: '0',
            updatedAt: record.updatedAt,
        }));
        sendSuccess(res, {
            holdings,
            total_portfolio_value: calculateTotalPortfolioValue(holdings),
        });
    } catch (error) {
        next(error);
    }
};
