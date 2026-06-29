export function compute24hPriceChange(current: bigint, price24hAgo: bigint): number {
   if (price24hAgo === 0n) {
      return 0;
   }

   const change = current - price24hAgo;
   const sign = change < 0n ? -1n : 1n;
   const absoluteChange = change < 0n ? -change : change;
   const absoluteBase = price24hAgo < 0n ? -price24hAgo : price24hAgo;
   const roundedCents = (absoluteChange * 10000n + absoluteBase / 2n) / absoluteBase;
   const percentage = Number(sign * roundedCents) / 100;

   return Number(percentage.toFixed(2));
}
