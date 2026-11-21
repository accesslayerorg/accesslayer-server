import { Router } from 'express';
import {
   httpFollow,
   httpUnfollow,
   httpGetFollowerCount,
} from './follower.controllers';

const followerRouter = Router();

followerRouter.post('/:creatorWallet/follow', httpFollow);
followerRouter.post('/:creatorWallet/unfollow', httpUnfollow);
followerRouter.get('/:creatorWallet/count', httpGetFollowerCount);

export default followerRouter;
