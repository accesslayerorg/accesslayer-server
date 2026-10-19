// src/modules/revenue/creator-revenue.controller.ts
import { Request, Response, NextFunction } from 'express';
import { creatorRevenueService } from './creator-revenue.service';
import { sendError, sendSuccess } from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';

function unauthorized(res: Response) {
   sendError(res, 403, ErrorCode.FORBIDDEN, 'Forbidden');
}

export async function getCreatorRevenueHandler(req: Request, res: Response, next: NextFunction) {
   const wallet = req.params.wallet as string;
   const auth = req.headers.authorization;
   if (!auth) return unauthorized(res);
   try {
      const data = await creatorRevenueService.getCreatorRevenue(wallet);
      sendSuccess(res, data);
   } catch (e) { next(e); }
}

export async function getRevenueHistoryHandler(req: Request, res: Response, next: NextFunction) {
   const wallet = req.params.wallet as string;
   const auth = req.headers.authorization;
   if (!auth) return unauthorized(res);
   const page = Number(req.query.page ?? 1);
   const pageSize = Number(req.query.pageSize ?? 20);
   try {
      const data = await creatorRevenueService.getRevenueHistory(wallet, page, pageSize);
      sendSuccess(res, data);
   } catch (e) { next(e); }
}

export async function withdrawHandler(req: Request, res: Response, next: NextFunction) {
   const wallet = req.params.wallet as string;
   const auth = req.headers.authorization;
   if (!auth) return unauthorized(res);
   try {
      const data = await creatorRevenueService.buildWithdrawTransaction(wallet);
      sendSuccess(res, data);
   } catch (e) { next(e); }
}
