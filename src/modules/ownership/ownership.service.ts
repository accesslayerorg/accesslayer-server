import { prisma } from '../../utils/prisma.utils';
import { OwnershipQueryType } from './ownership.schemas';

type KeyOwnership = NonNullable<Awaited<ReturnType<typeof prisma.keyOwnership.findFirst>>>;

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
