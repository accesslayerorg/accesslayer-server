import { prisma } from '../../utils/prisma.utils';
import { isValidStellarAddress } from '../wallet/wallet.utils';
import { HoldingEntry } from './wallet-holdings.schemas';

/**
 * Fetches all creator key holdings for a given Stellar wallet address.
 * Returns a tuple of [items, total] so the controller has the count without
 * a second query.
 *
 * Each entry includes:
 *   - creator_id, creator_handle
 *   - key_count  (the raw Decimal balance from KeyOwnership)
 *   - current_price (the price_at_trade from the most recent trade involving this creator, if any)
 *   - total_value   (null — not calculated server-side; consumers derive it from key_count * current_price)
 */
export async function fetchWalletHoldings(
    address: string
): Promise<[HoldingEntry[], number]> {
    if (!isValidStellarAddress(address)) {
        const err = Object.assign(
            new Error('Invalid Stellar wallet address'),
            { statusCode: 400, code: 'VALIDATION_ERROR' }
        );
        throw err;
    }

    const rows = await prisma.keyOwnership.findMany({
        where: {
            ownerAddress: address,
            balance: { gt: 0 },
        },
        orderBy: { createdAt: 'desc' },
    });

    const total = rows.length;

    if (total === 0) {
        return [[], 0];
    }

    const creatorIds = [...new Set(rows.map((r: { creatorId: string }) => r.creatorId))];

    // Resolve creator handles in one batched query
    const creatorProfiles = await prisma.creatorProfile.findMany({
        where: { id: { in: creatorIds } },
        select: { id: true, handle: true },
    });
    const handleMap = new Map(
        creatorProfiles.map((c: { id: string; handle: string }) => [c.id, c.handle])
    );

    // Resolve latest price per creator from the price snapshot read model
    const priceSnapshots = await prisma.creatorPriceSnapshot.findMany({
        where: { creatorId: { in: creatorIds } },
        select: { creatorId: true, currentPrice: true },
    });

    const priceMap = new Map<string, bigint>();
    for (const snap of priceSnapshots) {
        priceMap.set(snap.creatorId as string, snap.currentPrice as bigint);
    }

    const items: HoldingEntry[] = rows.map((row: { creatorId: string; balance: unknown }) => {
        const rawPrice = priceMap.get(row.creatorId) ?? null;
        const currentPrice = rawPrice !== null ? rawPrice.toString() : null;
        const totalValue =
            rawPrice !== null && row.balance !== null
                ? (Number(row.balance) * Number(rawPrice)).toString()
                : null;
        return {
            creator_id: row.creatorId,
            creator_handle: handleMap.get(row.creatorId) ?? null,
            key_count: row.balance,
            current_price: currentPrice,
            total_value: totalValue,
        };
    });

    return [items, total];
}
