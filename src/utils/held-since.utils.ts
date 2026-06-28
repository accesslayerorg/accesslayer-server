export interface TradeEvent {
  walletAddress: string;
  creatorId: string;
  type: 'buy' | 'sell';
  timestamp: Date;
}

/**
 * Returns the timestamp of the earliest buy event for the given wallet and
 * creator, or null if no matching buy event exists.
 */
export function getHeldSince(
  walletAddress: string,
  creatorId: string,
  tradeEvents: TradeEvent[]
): Date | null {
  const buyTimestamps = tradeEvents
    .filter(
      (e) =>
        e.type === 'buy' &&
        e.walletAddress === walletAddress &&
        e.creatorId === creatorId
    )
    .map((e) => e.timestamp.getTime());

  if (buyTimestamps.length === 0) return null;

  return new Date(Math.min(...buyTimestamps));
}
