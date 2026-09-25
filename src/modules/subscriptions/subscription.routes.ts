import { Router } from 'express';
import { jwtAuth } from '../../middlewares/jwt.middleware';
import {
   httpCreateSubscription,
   httpGetSubscriptions,
   httpDeleteSubscription,
   httpStreamSubscription,
} from './subscription.controllers';

const subscriptionRouter = Router();

subscriptionRouter.post('/', jwtAuth, httpCreateSubscription);
subscriptionRouter.get('/', jwtAuth, httpGetSubscriptions);
subscriptionRouter.delete('/:subscriptionId', jwtAuth, httpDeleteSubscription);
subscriptionRouter.get(
   '/:subscriptionId/stream',
   jwtAuth,
   httpStreamSubscription
);

export default subscriptionRouter;
