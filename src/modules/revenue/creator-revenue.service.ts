// src/modules/revenue/creator-revenue.service.ts
export interface RevenueTotals {
   royalties: string;
   subscription_fees: string;
   dividend_deposits: string;
   pending: string;
   claimed: string;
   total: string;
}

export interface RevenueEvent {
   type: 'royalty' | 'subscription_fee' | 'dividend_deposit' | 'withdrawal';
   amount: string;
   timestamp: string;
   txHash?: string;
   sources?: Record<string, string>;
}

export interface PaginationResult {
   items: RevenueEvent[];
   page: number;
   pageSize: number;
   total: number;
}

export interface UnsignedTransaction {
   type: 'claim_revenue';
   wallet: string;
   amount: string;
   sources: Record<string, string>;
   submit: false;
}

const eventsByWallet = new Map<string, RevenueEvent[]>();
const withdrawalsByWallet = new Map<string, RevenueEvent[]>();

function seed(wallet: string): RevenueEvent[] {
   if (!eventsByWallet.has(wallet)) eventsByWallet.set(wallet, []);
   return eventsByWallet.get(wallet)!;
}

export const creatorRevenueService = {
   async getCreatorRevenue(wallet: string): Promise<RevenueTotals> {
      const events = seed(wallet);
      const totals = { royalties: 0n, subscription_fees: 0n, dividend_deposits: 0n };
      let pending = 0n;
      let claimed = 0n;
      for (const e of events) {
         const amt = BigInt(e.amount);
         if (e.type === 'royalty') totals.royalties += amt;
         else if (e.type === 'subscription_fee') totals.subscription_fees += amt;
         else if (e.type === 'dividend_deposit') totals.dividend_deposits += amt;
         else if (e.type === 'withdrawal') claimed += amt;
      }
      const earned = totals.royalties + totals.subscription_fees + totals.dividend_deposits;
      pending = earned - claimed;
      const total = earned;
      return {
         royalties: totals.royalties.toString(),
         subscription_fees: totals.subscription_fees.toString(),
         dividend_deposits: totals.dividend_deposits.toString(),
         pending: pending.toString(),
         claimed: claimed.toString(),
         total: total.toString(),
      };
   },

   async getRevenueHistory(wallet: string, page: number, pageSize: number): Promise<PaginationResult> {
      const events = [...seed(wallet), ...(withdrawalsByWallet.get(wallet) ?? [])];
      const sorted = events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
      const total = sorted.length;
      const start = (page - 1) * pageSize;
      const items = sorted.slice(start, start + pageSize);
      return { items, page, pageSize, total };
   },

   async buildWithdrawTransaction(wallet: string): Promise<UnsignedTransaction> {
      const totals = await this.getCreatorRevenue(wallet);
      return {
         type: 'claim_revenue',
         wallet,
         amount: totals.pending,
         sources: {
            royalties: totals.royalties,
            subscription_fees: totals.subscription_fees,
            dividend_deposits: totals.dividend_deposits,
         },
         submit: false,
      };
   },

   async recordWithdrawal(wallet: string, txHash: string, amount: string, sources: Record<string, string>): Promise<void> {
      const event: RevenueEvent = {
         type: 'withdrawal',
         amount,
         timestamp: new Date().toISOString(),
         txHash,
         sources,
      };
      if (!withdrawalsByWallet.has(wallet)) withdrawalsByWallet.set(wallet, []);
      withdrawalsByWallet.get(wallet)!.push(event);
   },
};
