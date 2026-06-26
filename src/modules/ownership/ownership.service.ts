import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { OwnershipQueryType } from './ownership.schemas';

type KeyOwnership = NonNullable<Awaited<ReturnType<typeof prisma.keyOwnership.findFirst>>>;

function maskAddress(address: string): string {
  if (address.length <= 8) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

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

export interface OwnershipUpdateContext {
  event_type?: 'buy' | 'sell';
  ledger_sequence?: number;
}

export async function updateOwnership(
    ownerAddress: string,
    creatorId: string,
    balanceChange: number,
    ctx: OwnershipUpdateContext = {},
): Promise<KeyOwnership> {
    const existing = await prisma.keyOwnership.findFirst({
        where: { ownerAddress, creatorId },
        select: { balance: true },
    });
    const previousBalance = existing ? Number(existing.balance) : 0;

    const result = await prisma.keyOwnership.upsert({
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

    logger.debug({
        creator_id: creatorId,
        wallet_address: maskAddress(ownerAddress),
        previous_balance: previousBalance,
        new_balance: Number(result.balance),
        event_type: ctx.event_type,
        ledger_sequence: ctx.ledger_sequence,
    }, 'Ownership read model updated');

    return result;
}
