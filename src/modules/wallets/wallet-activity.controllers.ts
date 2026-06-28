import { Request, Response, NextFunction } from 'express';
import { WalletActivityParamsSchema, WalletActivityQuerySchema } from './wallet-activity.schemas';
import { fetchWalletActivity } from './wallet-activity.service';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';
import { buildOffsetPaginationMeta } from '../../utils/pagination.utils';
import { logger } from '../../utils/logger.utils';

export async function httpGetWalletActivity(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const parsedParams = WalletActivityParamsSchema.safeParse(req.params);
        if (!parsedParams.success) {
            sendValidationError(
                res,
                'Invalid wallet address',
                parsedParams.error.issues.map((issue: { path: (string | number)[]; message: string }) => ({
                    field: `address`,
                    message: issue.message,
                }))
            );
            return;
        }

        const parsedQuery = WalletActivityQuerySchema.safeParse(req.query);
        if (!parsedQuery.success) {
            sendValidationError(
                res,
                'Invalid query parameters',
                parsedQuery.error.issues.map((issue: { path: (string | number)[]; message: string }) => ({
                    field: issue.path.join('.'),
                    message: issue.message,
                }))
            );
            return;
        }

        const t0 = performance.now();
        const [items, total] = await fetchWalletActivity(
            parsedParams.data.address,
            parsedQuery.data
        );
        const duration = performance.now() - t0;

        const filters_applied = [];
        if (parsedQuery.data.type) filters_applied.push('type');
        if (parsedQuery.data.creator_id) filters_applied.push('creator_id');

        const address = parsedParams.data.address;
        const maskedAddress = address.length >= 8 
            ? `${address.slice(0, 4)}...${address.slice(-4)}`
            : address;

        logger.debug({
            wallet_address: maskedAddress,
            result_count: items.length,
            query_duration_ms: Math.round(duration),
            filters_applied
        }, 'Wallet activity feed query');

        sendSuccess(res, {
            items,
            meta: buildOffsetPaginationMeta({
                limit: parsedQuery.data.limit,
                offset: parsedQuery.data.offset,
                total,
            }),
        });
    } catch (error) {
        next(error);
    }
}
