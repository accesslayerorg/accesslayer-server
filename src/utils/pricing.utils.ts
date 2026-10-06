/**
 * Helper for computing the XLM cost to buy N keys at the current supply using the bonding curve formula.
 * Note: This is a placeholder implementation since the real bonding curve math is trapped in an unmerged PR.
 * 
 * @param currentSupply - The current supply of keys
 * @param amount - The number of keys to buy
 * @param feeBps - The protocol fee in basis points (e.g. 500 = 5%)
 * @returns Total XLM cost in stroops as a bigint
 */
export function computeBuyCost(currentSupply: number, amount: number, feeBps: number): bigint {
   if (amount < 0 || currentSupply < 0) {
      throw new Error('Supply and amount must be non-negative');
   }
   
   if (amount === 0) {
      return 0n;
   }

   // Placeholder bonding curve math: Price = 10,000,000 stroops (1 XLM) base + 1,000,000 stroops per supply
   const BASE_COST = 10_000_000n;
   const STEP = 1_000_000n;

   let totalBaseCost = 0n;
   for (let i = 0; i < amount; i++) {
      const supplyAtPurchase = BigInt(currentSupply + i);
      totalBaseCost += BASE_COST + (supplyAtPurchase * STEP);
   }

   // Add fee
   const fee = (totalBaseCost * BigInt(feeBps)) / 10000n;
   const totalCost = totalBaseCost + fee;

   if (totalCost < 0n) {
      return 0n; // fallback to ensure it never returns negative
   }

   return totalCost;
}

/**
 * Helper for computing the XLM payout for selling N keys at the current supply using the
 * bonding curve formula, net of the protocol fee.
 * Note: This is a placeholder implementation since the real bonding curve math is trapped in an unmerged PR.
 *
 * @param currentSupply - The current supply of keys (before the sell)
 * @param amount - The number of keys to sell
 * @param feeBps - The protocol fee in basis points (e.g. 500 = 5%)
 * @returns Net XLM payout in stroops as a bigint (never negative)
 */
export function computeSellPayout(currentSupply: number, amount: number, feeBps: number): bigint {
   if (amount < 0 || currentSupply < 0) {
      throw new Error('Supply and amount must be non-negative');
   }

   if (amount > currentSupply) {
      throw new Error('Cannot sell more keys than the current supply');
   }

   if (amount === 0) {
      return 0n;
   }

   // Same placeholder bonding curve as computeBuyCost. Selling walks the
   // curve back down: the key at the top of the supply (currentSupply - 1)
   // is sold first, then currentSupply - 2, and so on.
   const BASE_COST = 10_000_000n;
   const STEP = 1_000_000n;

   let grossPayout = 0n;
   for (let i = 0; i < amount; i++) {
      const supplyAtSale = BigInt(currentSupply - 1 - i);
      grossPayout += BASE_COST + (supplyAtSale * STEP);
   }

   const fee = (grossPayout * BigInt(feeBps)) / 10000n;
   const netPayout = grossPayout - fee;

   if (netPayout < 0n) {
      return 0n; // fee exceeding gross (e.g. feeBps > 10000) must never yield a negative payout
   }

   return netPayout;
}

/**
 * Current unit buy price on the bonding curve (stroops per key), including
 * the protocol fee. Used for server-side slippage validation on buys (#884).
 *
 * @param currentSupply - The current supply of keys
 * @param feeBps - The protocol fee in basis points (e.g. 500 = 5%)
 * @returns Unit price in stroops as a bigint
 */
export function getBuyUnitPrice(currentSupply: number, feeBps: number): bigint {
   return computeBuyCost(currentSupply, 1, feeBps);
}

/**
 * Current unit sell price on the bonding curve (stroops per key), net of the
 * protocol fee. Used for server-side slippage validation on sells (#884).
 *
 * @param currentSupply - The current supply of keys
 * @param feeBps - The protocol fee in basis points (e.g. 500 = 5%)
 * @returns Unit payout in stroops as a bigint; 0 when supply is empty
 */
export function getSellUnitPrice(
   currentSupply: number,
   feeBps: number
): bigint {
   if (currentSupply <= 0) {
      return 0n;
   }
   return computeSellPayout(currentSupply, 1, feeBps);
}
