import { AsyncController } from '../../types/auth.types';
import { RegisterWebhookSchema, SimulateTradeSchema } from './webhook.schemas';
import { upsertWebhookSubscription, findMatchingSubscriptions } from './webhook.service';
import { sendSuccess, sendValidationError } from '../../utils/api-response.utils';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';

export const httpRegisterWebhook: AsyncController = async (req, res, next) => {
    try {
        const parsed = RegisterWebhookSchema.safeParse(req.body);
        if (!parsed.success) {
            return sendValidationError(
                res,
                'Invalid webhook registration payload',
                parsed.error.issues.map(issue => ({
                    field: issue.path.join('.'),
                    message: issue.message,
                }))
            );
        }

        const subscription = await upsertWebhookSubscription(
            parsed.data.url,
            parsed.data.events
        );

        sendSuccess(res, subscription);
    } catch (error) {
        next(error);
    }
};

export const httpSimulateTrade: AsyncController = async (req, res, next) => {
    try {
        const parsed = SimulateTradeSchema.safeParse(req.body);
        if (!parsed.success) {
            return sendValidationError(
                res,
                'Invalid trade simulation payload',
                parsed.error.issues.map(issue => ({
                    field: issue.path.join('.'),
                    message: issue.message,
                }))
            );
        }

        const { type, amount, price, creatorId, actor } = parsed.data;

        // 1. Create corresponding Activity record
        const activityType = type === 'buy' ? 'KEY_BOUGHT' : 'KEY_SOLD';
        const activity = await prisma.activity.create({
            data: {
                type: activityType as any,
                actor,
                creatorId,
                payload: { amount, price },
            },
        });

        // 2. Query subscriptions subscribed to this type
        const subscriptions = await findMatchingSubscriptions(type);

        // 3. Deliver webhook payloads
        await Promise.all(
            subscriptions.map(async (sub: any) => {
                try {
                    await fetch(sub.url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            event_type: type,
                            activity,
                        }),
                    });
                } catch (err: any) {
                    logger.error(
                        { err: err.message, url: sub.url },
                        'Failed to deliver webhook'
                    );
                }
            })
        );

        sendSuccess(res, { activity, deliveredTo: subscriptions.map((s: any) => s.url) });
    } catch (error) {
        next(error);
    }
};
