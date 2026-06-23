import { prisma } from '../../utils/prisma.utils';
import { OwnershipQueryType } from './ownership.schemas';

export type KeyOwnership = NonNullable<Awaited<ReturnType<typeof prisma.keyOwnership.findFirst>>>;

export async function fetchOwnership(
    query: OwnershipQueryType
): Promise<KeyOwnership[]> {
    const { ownerAddress, creatorId } = query;

    const where: any = {};
    if (ownerAddress) where.ownerAddress = ownerAddress;
    if (creatorId) where.creatorId = creatorId;

    return prisma.keyOwnership.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
    });
}

/**
 * Fetch the wallet holdings that should appear in the public-facing
 * `GET /api/v1/wallets/:address/holdings` response.
 *
 * Zero-balance entries are intentionally excluded: holders who have sold,
 * transferred, or never acquired any keys for a given creator must not
 * appear in the wallet's holdings list. The filter is applied at the
 * database level to avoid round-tripping rows the caller will discard.
 */
export async function fetchWalletHoldings(
    ownerAddress: string
): Promise<KeyOwnership[]> {
    return prisma.keyOwnership.findMany({
        where: {
            ownerAddress,
            balance: { gt: 0 },
        },
        orderBy: { updatedAt: 'desc' },
    });
}

export async function updateOwnership(
    ownerAddress: string,
    creatorId: string,
    balanceChange: number
): Promise<KeyOwnership> {
    return prisma.keyOwnership.upsert({
        where: {
            ownerAddress_creatorId: {
                ownerAddress,
                creatorId,
            },
        },
        update: {
            balance: { increment: balanceChange },
        },
        create: {
            ownerAddress,
            creatorId,
            balance: balanceChange,
        },
    });
}
