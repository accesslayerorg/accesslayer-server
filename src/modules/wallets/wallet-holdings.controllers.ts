import { Request, Response, NextFunction } from 'express';
import { WalletHoldingsParamsSchema } from './wallet-holdings.schemas';
import { fetchWalletHoldings } from './wallet-holdings.service';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';

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

        const [items, total] = await fetchWalletHoldings(parsedParams.data.address);

        sendSuccess(res, { items, total });
    } catch (error) {
        next(error);
    }
}
