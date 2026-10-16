import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { prisma } from '../../utils/prisma.utils';

export const LIQUIDITY_DEPTH_CACHE_TTL_SECONDS = 10;
export const DEFAULT_MAX_BUY_PER_TRADE = 10_000;

export type TradeSide = 'buy' | 'sell';

export interface LiquidityDepthOracleProvider {
   get_max_buy(keyId: string): Promise<number>;
   get_max_sell(keyId: string): Promise<number>;
}

export interface DepthOrderError {
   keyId: string;
   side: TradeSide;
   requestedAmount: number;
   max_available: number;
   code: 'InsufficientDepth';
}

export class InsufficientDepthError extends Error {
   public readonly code = 'InsufficientDepth';

   constructor(
      public readonly keyId: string,
      public readonly side: TradeSide,
      public readonly requestedAmount: number,
      public readonly max_available: number,
      public readonly orderErrors?: DepthOrderError[]
   ) {
      super(
         `Insufficient liquidity depth for ${side} on key ${keyId}: requested ${requestedAmount}, max_available ${max_available}`
      );
      this.name = 'InsufficientDepthError';
   }
}

const defaultOracleProvider: LiquidityDepthOracleProvider = {
   async get_max_buy(keyId: string): Promise<number> {
      const creator = await prisma.creatorProfile.findFirst({
         where: { OR: [{ id: keyId }, { handle: keyId }] },
         select: { circulatingSupply: true },
      });
      if (!creator) {
         return DEFAULT_MAX_BUY_PER_TRADE;
      }
      return DEFAULT_MAX_BUY_PER_TRADE;
   },

   async get_max_sell(keyId: string): Promise<number> {
      const creator = await prisma.creatorProfile.findFirst({
         where: { OR: [{ id: keyId }, { handle: keyId }] },
         select: { circulatingSupply: true },
      });
      if (!creator) {
         return 0;
      }
      return Number(creator.circulatingSupply.toString());
   },
};

function depthCacheKey(keyId: string, side: TradeSide): string {
   return `liquidity:depth:${side}:${keyId}`;
}

/**
 * Queries `get_max_buy` or `get_max_sell` from the liquidity depth oracle
 * contract with a 10-second cache to prevent redundant contract calls.
 */
export async function getAvailableLiquidityDepth(
   keyId: string,
   side: TradeSide,
   oracle: LiquidityDepthOracleProvider = defaultOracleProvider
): Promise<number> {
   const cacheKey = depthCacheKey(keyId, side);
   const cached = await cacheGetJson<{ max_available: number }>(cacheKey);
   if (cached !== null && typeof cached.max_available === 'number') {
      return cached.max_available;
   }

   const maxAvailable =
      side === 'buy'
         ? await oracle.get_max_buy(keyId)
         : await oracle.get_max_sell(keyId);

   await cacheSetJson(
      cacheKey,
      { max_available: maxAvailable },
      LIQUIDITY_DEPTH_CACHE_TTL_SECONDS
   );

   return maxAvailable;
}

/**
 * Pre-validates a single buy or sell order against the liquidity depth oracle.
 * Throws `InsufficientDepthError` with `max_available` when requestedAmount > max_available.
 */
export async function validateSingleTradeDepth(
   keyId: string,
   side: TradeSide,
   requestedAmount: number,
   oracle: LiquidityDepthOracleProvider = defaultOracleProvider
): Promise<{ keyId: string; side: TradeSide; max_available: number }> {
   const maxAvailable = await getAvailableLiquidityDepth(keyId, side, oracle);
   if (requestedAmount > maxAvailable) {
      throw new InsufficientDepthError(
         keyId,
         side,
         requestedAmount,
         maxAvailable
      );
   }
   return { keyId, side, max_available: maxAvailable };
}

/**
 * Pre-validates a batch of trade orders and returns per-order `InsufficientDepth`
 * details for every order that exceeds available liquidity depth.
 */
export async function validateBatchTradeDepth(
   orders: Array<{ keyId: string; side: TradeSide; amount: number }>,
   oracle: LiquidityDepthOracleProvider = defaultOracleProvider
): Promise<{
   valid: boolean;
   errors: DepthOrderError[];
}> {
   const errors: DepthOrderError[] = [];

   for (const order of orders) {
      const maxAvailable = await getAvailableLiquidityDepth(
         order.keyId,
         order.side,
         oracle
      );
      if (order.amount > maxAvailable) {
         errors.push({
            keyId: order.keyId,
            side: order.side,
            requestedAmount: order.amount,
            max_available: maxAvailable,
            code: 'InsufficientDepth',
         });
      }
   }

   return {
      valid: errors.length === 0,
      errors,
   };
}
