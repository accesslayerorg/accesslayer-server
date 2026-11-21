import { Request, Response, NextFunction } from 'express';
import { fetchWalletFeed } from './wallet-feed.service';
import { sendSuccess } from '../../utils/api-response.utils';

export async function httpGetWalletFeed(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const posts = await fetchWalletFeed(String(req.params.address));
      sendSuccess(res, posts);
   } catch (error) {
      next(error);
   }
}
