import { logger } from '../../utils/logger.utils';
import { computeBuyCost, getBuyUnitPrice } from '../../utils/pricing.utils';
import { MultiBuyLeg, MultiBuyResult } from './multi-buy.schemas';

const PROTOCOL_FEE_BPS = 500;

export class MultiBuyError extends Error {
   constructor(
      public readonly code: string,
      message: string,
      public readonly details?: {
         /** Current unit price (stroops) at the time of rejection (#884). */
         currentPrice?: string;
         /** Creator/leg the rejection applies to. */
         creator?: string;
         /** Submitted per-unit max_price bound (stroops). */
         maxPrice?: string;
      }
   ) {
      super(message);
      this.name = 'MultiBuyError';
   }
}

interface LedgerProvider {
   getCurrentLedger(): Promise<number>;
}

interface BalanceProvider {
   getXlmBalance(address: string): Promise<bigint>;
}

interface SupplyProvider {
   getCreatorSupply(creatorId: string): Promise<number>;
}

export async function executeMultiBuy(
   buyer: string,
   legs: MultiBuyLeg[],
   globalDeadlineLedger: number,
   providers: {
      ledger: LedgerProvider;
      balance: BalanceProvider;
      supply: SupplyProvider;
   }
): Promise<MultiBuyResult[]> {
   if (legs.length === 0) {
      throw new MultiBuyError('legs_empty', 'Legs vector must not be empty');
   }

   if (legs.length > 10) {
      throw new MultiBuyError(
         'too_many_legs',
         'Legs vector must not exceed 10 entries'
      );
   }

   const creatorSet = new Set<string>();
   for (const leg of legs) {
      if (creatorSet.has(leg.creator)) {
         throw new MultiBuyError(
            'duplicate_creator',
            `Duplicate creator in legs: ${leg.creator}`
         );
      }
      creatorSet.add(leg.creator);
   }

   const currentLedger = await providers.ledger.getCurrentLedger();
   if (currentLedger > globalDeadlineLedger) {
      throw new MultiBuyError(
         'deadline_passed',
         `Current ledger ${currentLedger} exceeds deadline ${globalDeadlineLedger}`
      );
   }

   let worstCaseTotal = 0n;
   for (const leg of legs) {
      worstCaseTotal += BigInt(leg.amount) * BigInt(leg.max_price);
   }

   const buyerBalance = await providers.balance.getXlmBalance(buyer);
   if (buyerBalance < worstCaseTotal) {
      throw new MultiBuyError(
         'insufficient_funds',
         `Buyer balance ${buyerBalance} is less than worst-case cost ${worstCaseTotal}`
      );
   }

   const results: MultiBuyResult[] = [];
   let totalCostAllLegs = 0n;

   for (const leg of legs) {
      const currentSupply = await providers.supply.getCreatorSupply(
         leg.creator
      );
      const cost = computeBuyCost(currentSupply, leg.amount, PROTOCOL_FEE_BPS);
      const maxAllowed = BigInt(leg.max_price) * BigInt(leg.amount);

      if (cost > maxAllowed) {
         const currentPrice = getBuyUnitPrice(
            currentSupply,
            PROTOCOL_FEE_BPS
         ).toString();
         throw new MultiBuyError(
            'slippage_exceeded',
            `Cost ${cost} for creator ${leg.creator} exceeds max_price ${leg.max_price} * ${leg.amount} = ${maxAllowed}`,
            { currentPrice, creator: leg.creator, maxPrice: leg.max_price }
         );
      }

      const newSupply = currentSupply + leg.amount;
      totalCostAllLegs += cost;

      logger.debug(
         {
            event: 'key_purchased',
            buyer,
            creator: leg.creator,
            amount: leg.amount,
            total_cost: cost.toString(),
            new_supply: newSupply,
            ledger: currentLedger,
         },
         'Key purchased via multi-buy'
      );

      results.push({
         creator: leg.creator,
         amount: leg.amount,
         total_cost: cost.toString(),
         new_supply: newSupply,
      });
   }

   logger.debug(
      {
         event: 'multi_buy_completed',
         buyer,
         leg_count: results.length,
         total_cost: totalCostAllLegs.toString(),
         ledger: currentLedger,
      },
      'MultiBuyCompleted'
   );

   return results;
}
