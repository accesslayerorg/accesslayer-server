import { prisma } from '../../utils/prisma.utils';
import { WalletActivityItem, WalletActivityQueryType } from './wallet-activity.schemas';

/**
 * Fetches the paginated trade activity (KEY_BOUGHT / KEY_SOLD) for a single
 * wallet address. Returns a tuple of [items, total] so the controller can
 * build pagination metadata without a second call.
 *
 * The payload stored in Activity for trades is expected to contain:
 *   { amount, price_at_trade, fee_paid, ledger_sequence }
 */
import { decodeCursor, encodeCursor } from '../../utils/cursor.utils';

/**
 * Shape of decoded activity cursor
 */
export interface ActivityFeedCursorPayload {
    id: string;
}

export async function fetchWalletActivity(
    address: string,
    query: WalletActivityQueryType
): Promise<[WalletActivityItem[], number, string | null]> {
    const { limit, offset, type, creator_id, cursor } = query;

    // Map the public-facing type param to the internal ActivityType enum values.
    const typeFilter =
        type === 'buy' ? 'KEY_BOUGHT' :
        type === 'sell' ? 'KEY_SOLD' :
        undefined;

    const where: any = {
        actor: address,
        type: typeFilter
            ? typeFilter
            : { in: ['KEY_BOUGHT', 'KEY_SOLD'] },
    };

    if (creator_id) {
        where.creatorId = creator_id;
    }

    let prismaCursor: { id: string } | undefined;
    if (cursor) {
        try {
            const decoded = decodeCursor<ActivityFeedCursorPayload>(cursor);
            if (decoded && decoded.id) {
                prismaCursor = { id: decoded.id };
            }
        } catch (e) {
            // Ignore tampered cursor and fall back
        }
    }

    const [rows, total] = await Promise.all([
        prisma.activity.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: prismaCursor ? 1 : offset,
            take: limit,
            ...(prismaCursor ? { cursor: prismaCursor } : {}),
        }),
        prisma.activity.count({ where }),
    ]);

    if (rows.length === 0) {
        return [[], total, null];
    }

    // Resolve creator handles in a single batched query.
    const creatorIds = [...new Set(rows.map((r: { creatorId: string | null }) => r.creatorId).filter(Boolean))] as string[];
    const creatorProfiles = await prisma.creatorProfile.findMany({
        where: { id: { in: creatorIds } },
        select: { id: true, handle: true },
    });
    const handleMap = new Map(creatorProfiles.map((c: { id: string; handle: string }) => [c.id, c.handle]));

    const items: WalletActivityItem[] = rows.map((row: { type: string; creatorId: string | null; payload: unknown; createdAt: Date }) => {
        const payload = (row.payload ?? {}) as Record<string, any>;
        return {
            id: row.id,
            type: row.type === 'KEY_BOUGHT' ? 'buy' : 'sell',
            creator_id: row.creatorId ?? '',
            creator_handle: row.creatorId ? (handleMap.get(row.creatorId) ?? null) : null,
            amount: payload.amount ?? null,
            price_at_trade: payload.price_at_trade ?? null,
            fee_paid: payload.fee_paid ?? null,
            ledger_sequence: payload.ledger_sequence != null ? Number(payload.ledger_sequence) : null,
            timestamp: row.createdAt,
        };
    });

    const hasMore = prismaCursor ? items.length === limit : offset + limit < total;
    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
        const lastItem = items[items.length - 1];
        nextCursor = encodeCursor<ActivityFeedCursorPayload>({ id: lastItem.id });
    }

    return [items, total, nextCursor];
}
