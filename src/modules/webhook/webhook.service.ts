import { prisma } from '../../utils/prisma.utils';

export async function upsertWebhookSubscription(url: string, events: string[]) {
    return prisma.webhookSubscription.upsert({
        where: { url },
        create: { url, events },
        update: { events },
    });
}

export async function findMatchingSubscriptions(eventType: 'buy' | 'sell') {
    return prisma.webhookSubscription.findMany({
        where: {
            events: {
                has: eventType,
            },
        },
    });
}
