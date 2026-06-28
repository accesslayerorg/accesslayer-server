export interface HoldingEntry {
  balance: string;
  currentPrice: string;
}

export function calculateTotalPortfolioValue(entries: HoldingEntry[]): string {
  const total = entries.reduce(
    (sum, entry) => sum + Number(entry.balance) * Number(entry.currentPrice),
    0,
  );
  return String(total);
}
