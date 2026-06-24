import { AsyncController } from '../../types/auth.types';
import { fetchWalletHoldings } from '../ownership/ownership.service';
import { calculateTotalPortfolioValue } from '../ownership/ownership.utils';
import { StellarAddressSchema } from './wallet.schemas';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';

/**
 * GET /api/v1/wallets/:address/holdings
 *
 * Returns the creator-key holdings owned by a Stellar wallet. Zero-balance
 * entries (sold, transferred, or never-purchased) are excluded by the
 * underlying service query, so the returned array is always the public face
 * of the wallet's portfolio.
 *
 * The `:address` path parameter must itself be a valid Stellar public
 * key — we re-validate it here so the service layer is never asked to
 * query with an unparseable value.
 */
export const httpGetWalletHoldings: AsyncController = async (
    req,
    res,
    next
) => {
    try {
        const rawAddress = Array.isArray(req.params?.address)
            ? req.params.address[0]
            : req.params?.address;

        const parsedAddress = StellarAddressSchema.safeParse(rawAddress);
        if (!parsedAddress.success) {
            return sendValidationError(
                res,
                'Invalid wallet address in path parameter',
                parsedAddress.error.issues.map(issue => ({
                    field: 'address',
                    message: issue.message,
                }))
            );
        }

        const records = await fetchWalletHoldings(parsedAddress.data);

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
