import { prisma } from '../../utils/prisma.utils';
import { ActivityQueryType } from './activity.schemas';

type Activity = NonNullable<Awaited<ReturnType<typeof prisma.activity.findFirst>>>;

export async function fetchActivityFeed(
    query: ActivityQueryType
): Promise<[Activity[], number]> {
    const { limit, offset, creatorId, actor, type } = query;

    const where: any = {};
    if (creatorId) where.creatorId = creatorId;
    if (actor) where.actor = actor;
    if (type) where.type = type;

    const [items, total] = await Promise.all([
        prisma.activity.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: offset,
            take: limit,
        }),
        prisma.activity.count({ where }),
    ]);

    return [items, total];
}
