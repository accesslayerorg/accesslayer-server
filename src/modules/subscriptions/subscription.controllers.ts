import { AsyncController } from '../../types/auth.types';
import { CreateSubscriptionSchema } from './subscription.schemas';
import {
   createSubscription,
   getSubscription,
   isThrottled,
   incrementConnectionCount,
   touchSubscription,
} from './subscription.service';
import {
   sendSuccess,
   sendValidationError,
   sendNotFound,
   sendUnauthorized,
} from '../../utils/api-response.utils';
import { envConfig } from '../../config';
import {
   registerConnection,
   closeConnection,
} from '../../utils/sse-fanout.utils';
import { HTTP_STATUS } from '../../utils/logger.utils';

const MAX_CONNECTIONS = envConfig.SSE_MAX_CONNECTIONS_PER_WALLET;

function getSubId(req: { params: Record<string, string | string[]> }): string {
   const id = req.params.subscriptionId;
   return Array.isArray(id) ? id[0] : id;
}

export const httpCreateSubscription: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const parsed = CreateSubscriptionSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid subscription request',
            parsed.error.issues.map(issue => ({
               field: issue.path.join('.'),
               message: issue.message,
            }))
         );
         return;
      }

      const walletAddress = req.jwtPayload!.walletAddress;
      const sub = await createSubscription(walletAddress, parsed.data.topics);

      sendSuccess(res, sub, HTTP_STATUS.CREATED);
   } catch (error: any) {
      if (error.code === 'subscription_limit_reached') {
         res.status(409).json({
            success: false,
            error: {
               code: 'subscription_limit_reached',
               message: 'Maximum of 5 concurrent subscriptions per wallet',
            },
         });
         return;
      }
      next(error);
   }
};

export const httpGetSubscriptions: AsyncController = async (req, res, next) => {
   try {
      const walletAddress = req.jwtPayload!.walletAddress;
      const { getWalletSubscriptions } = await import('./subscription.service');
      const subs = await getWalletSubscriptions(walletAddress);
      sendSuccess(res, subs);
   } catch (error) {
      next(error);
   }
};

export const httpDeleteSubscription: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const subscriptionId = getSubId(req);
      const sub = await getSubscription(subscriptionId);
      if (!sub) {
         sendNotFound(res, 'Subscription');
         return;
      }

      if (sub.walletAddress !== req.jwtPayload!.walletAddress) {
         sendUnauthorized(res, 'You do not own this subscription');
         return;
      }

      const { deleteSubscription } = await import('./subscription.service');
      await deleteSubscription(subscriptionId);

      res.status(204).send();
   } catch (error) {
      next(error);
   }
};

export const httpStreamSubscription: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const subscriptionId = getSubId(req);
      const walletAddress = req.jwtPayload!.walletAddress;

      const sub = await getSubscription(subscriptionId);
      if (!sub) {
         sendNotFound(res, 'Subscription');
         return;
      }

      if (sub.walletAddress !== walletAddress) {
         sendUnauthorized(res, 'You do not own this subscription');
         return;
      }

      const throttled = await isThrottled(walletAddress);
      if (throttled) {
         res.setHeader('Retry-After', '60');
         res.status(429).json({
            success: false,
            error: {
               code: 'subscription_throttled',
               message: 'Subscription is throttled. Retry after 60 seconds.',
            },
         });
         return;
      }

      const connectionCount = await incrementConnectionCount(walletAddress);
      if (connectionCount > MAX_CONNECTIONS) {
         res.status(429).json({
            success: false,
            error: {
               code: 'too_many_connections',
               message: `Maximum of ${MAX_CONNECTIONS} concurrent SSE connections per wallet`,
            },
         });
         return;
      }

      await touchSubscription(subscriptionId);

      const sseHeaders: Record<string, string> = {
         'Content-Type': 'text/event-stream',
         'Cache-Control': 'no-cache',
         Connection: 'keep-alive',
         'X-Accel-Buffering': 'no',
      };

      res.writeHead(200, sseHeaders);
      res.write(': connected\n\n');

      registerConnection(subscriptionId, walletAddress, res);

      req.on('close', () => {
         closeConnection(subscriptionId);
      });

      req.on('error', () => {
         closeConnection(subscriptionId);
      });
   } catch (error) {
      next(error);
   }
};
