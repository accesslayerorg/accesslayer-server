import { Request, Response, NextFunction } from 'express';
import { WalletHoldingsParamsSchema, WalletHoldingsQuerySchema } from './wallet-holdings.schemas';
import { fetchWalletHoldings } from './wallet-holdings.service';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';
import { buildOffsetPaginationMeta } from '../../utils/pagination.utils';

export async function httpGetWalletHoldings(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const parsedParams = WalletHoldingsParamsSchema.safeParse(req.params);
        if (!parsedParams.success) {
            sendValidationError(
                res,
                'Invalid wallet address',
                parsedParams.error.issues.map((issue: { path: (string | number)[]; message: string }) => ({
                    field: 'address',
                    message: issue.message,
                }))
            );
            return;
        }

        const parsedQuery = WalletHoldingsQuerySchema.safeParse(req.query);
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

        const [items, total] = await fetchWalletHoldings(
            parsedParams.data.address,
            parsedQuery.data
        );

        const meta = buildOffsetPaginationMeta({
            limit: parsedQuery.data.limit,
            offset: parsedQuery.data.offset,
            total,
        });

        sendSuccess(res, { items, meta });
    } catch (error) {
        next(error);
    }
}
