import { Request, Response, NextFunction } from 'express';
import { WalletActivityParamsSchema, WalletActivityQuerySchema } from './wallet-activity.schemas';
import { fetchWalletActivity } from './wallet-activity.service';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';
import { buildOffsetPaginationMeta } from '../../utils/pagination.utils';

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

        const [items, total, nextCursor] = await fetchWalletActivity(
            parsedParams.data.address,
            parsedQuery.data
        );

        sendSuccess(res, {
            items,
            meta: {
                ...buildOffsetPaginationMeta({
                    limit: parsedQuery.data.limit,
                    offset: parsedQuery.data.offset,
                    total,
                }),
                nextCursor,
            },
        });
    } catch (error) {
        next(error);
    }
}
