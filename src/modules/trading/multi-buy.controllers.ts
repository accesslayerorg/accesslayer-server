import { AsyncController } from '../../types/auth.types';
import { MultiBuyRequestSchema } from './multi-buy.schemas';
import { executeMultiBuy, MultiBuyError } from './multi-buy.service';
import {
   sendSuccess,
   sendValidationError,
   sendError,
   sendForbidden,
   zodIssuesToDetails,
   ErrorCode,
} from '../../utils/api-response.utils';
import { horizonGet } from '../../clients/horizon.client';
import {
   assertTradingActive,
   TradingPausedError,
} from '../keys/key-trading.service';
import {
   assertPositionNotFrozen,
   PositionFrozenError,
} from '../keys/key-freeze.service';
import { logSlippageRejection, sendSlippageExceeded } from './slippage.service';

async function getCurrentLedger(): Promise<number> {
   const res = await horizonGet('/');
   const data = (await res.json()) as {
      core_latest_ledger?: number;
   };
   return data.core_latest_ledger ?? 0;
}

async function getXlmBalance(address: string): Promise<bigint> {
   const res = await horizonGet(`/accounts/${address}`);
   if (!res.ok) {
      return 0n;
   }
   const data = (await res.json()) as {
      balances?: Array<{
         asset_type: string;
         balance: string;
      }>;
   };
   const native = data.balances?.find(b => b.asset_type === 'native');
   if (!native) return 0n;
   const stroops = BigInt(Math.floor(parseFloat(native.balance) * 10_000_000));
   return stroops;
}

async function getCreatorSupply(creatorId: string): Promise<number> {
   const { prisma } = await import('../../utils/prisma.utils');
   const aggregate = await prisma.keyOwnership.aggregate({
      where: { creatorId },
      _sum: { balance: true },
   });
   return Number(aggregate._sum.balance ?? 0);
}

export const httpMultiBuy: AsyncController = async (req, res, next) => {
   let buyer: string | undefined;
   try {
      const parsed = MultiBuyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
         const firstIssue = parsed.error.issues[0];
         if (firstIssue?.message === 'legs_empty') {
            sendError(res, 400, ErrorCode.BAD_REQUEST, 'legs_empty');
            return;
         }
         if (firstIssue?.message === 'too_many_legs') {
            sendError(res, 400, ErrorCode.BAD_REQUEST, 'too_many_legs');
            return;
         }
         sendValidationError(
            res,
            'Invalid multi-buy request',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      const { buyer: buyerAddress, legs, global_deadline_ledger } = parsed.data;
      buyer = buyerAddress;

      await Promise.all(legs.map(leg => assertTradingActive(leg.creator)));

      // Self-custody freeze (#885): frozen positions cannot trade (403).
      for (const leg of legs) {
         try {
            await assertPositionNotFrozen(buyerAddress, leg.creator);
         } catch (error) {
            if (error instanceof PositionFrozenError) {
               sendForbidden(res, error.message);
               return;
            }
            throw error;
         }
      }

      const results = await executeMultiBuy(
         buyerAddress,
         legs,
         global_deadline_ledger,
         {
            ledger: { getCurrentLedger },
            balance: { getXlmBalance },
            supply: { getCreatorSupply },
         }
      );

      sendSuccess(res, results);
   } catch (err) {
      if (err instanceof TradingPausedError) {
         sendError(res, 503, ErrorCode.INTERNAL_ERROR, err.message);
         return;
      }
      if (err instanceof MultiBuyError) {
         if (err.code === 'slippage_exceeded') {
            const currentPrice = err.details?.currentPrice ?? '0';
            const submittedPrice = err.details?.maxPrice;
            logSlippageRejection({
               side: 'buy',
               wallet: buyer ?? 'unknown',
               keyId: err.details?.creator ?? 'unknown',
               currentPrice,
               submittedPrice: submittedPrice ?? 'unknown',
               unit: 'stroops',
               requestId: req.requestId,
            });
            sendSlippageExceeded(res, {
               side: 'buy',
               currentPrice,
               submittedPrice,
               unit: 'stroops',
            });
            return;
         }
         const statusMap: Record<string, number> = {
            legs_empty: 400,
            too_many_legs: 400,
            duplicate_creator: 400,
            deadline_passed: 400,
            insufficient_funds: 400,
            slippage_exceeded: 409,
         };
         const status = statusMap[err.code] ?? 500;
         sendError(res, status, err.code as any, err.message);
         return;
      }
      next(err);
   }
};
