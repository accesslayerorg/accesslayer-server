import { getHeldSince, TradeEvent } from './held-since.utils';

const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CREATOR = 'creator-abc';

function makeBuy(timestamp: Date, wallet = WALLET, creator = CREATOR): TradeEvent {
  return { walletAddress: wallet, creatorId: creator, type: 'buy', timestamp };
}

function makeSell(timestamp: Date, wallet = WALLET, creator = CREATOR): TradeEvent {
  return { walletAddress: wallet, creatorId: creator, type: 'sell', timestamp };
}

describe('getHeldSince', () => {
  it('returns null when the event list is empty', () => {
    expect(getHeldSince(WALLET, CREATOR, [])).toBeNull();
  });

  it('returns null when there are no buy events for the wallet/creator pair', () => {
    const events: TradeEvent[] = [makeSell(new Date('2026-01-01'))];
    expect(getHeldSince(WALLET, CREATOR, events)).toBeNull();
  });

  it('returns the timestamp of a single buy event', () => {
    const ts = new Date('2026-03-15T10:00:00Z');
    expect(getHeldSince(WALLET, CREATOR, [makeBuy(ts)])).toEqual(ts);
  });

  it('returns the earliest timestamp when multiple buy events exist', () => {
    const early = new Date('2026-01-01T00:00:00Z');
    const late = new Date('2026-06-01T00:00:00Z');
    const events = [makeBuy(late), makeBuy(early)];
    expect(getHeldSince(WALLET, CREATOR, events)).toEqual(early);
  });

  it('ignores sell events when finding the earliest buy', () => {
    const sellTs = new Date('2025-12-01T00:00:00Z');
    const buyTs = new Date('2026-02-01T00:00:00Z');
    const events = [makeSell(sellTs), makeBuy(buyTs)];
    expect(getHeldSince(WALLET, CREATOR, events)).toEqual(buyTs);
  });

  it('filters by walletAddress — ignores buys from other wallets', () => {
    const otherWallet = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA';
    const events = [makeBuy(new Date('2026-01-01'), otherWallet)];
    expect(getHeldSince(WALLET, CREATOR, events)).toBeNull();
  });

  it('filters by creatorId — ignores buys for other creators', () => {
    const events = [makeBuy(new Date('2026-01-01'), WALLET, 'creator-other')];
    expect(getHeldSince(WALLET, CREATOR, events)).toBeNull();
  });

  it('returns the correct earliest among many buys for the same wallet/creator', () => {
    const ts1 = new Date('2026-03-01T00:00:00Z');
    const ts2 = new Date('2026-01-01T00:00:00Z');
    const ts3 = new Date('2026-05-01T00:00:00Z');
    const events = [makeBuy(ts1), makeBuy(ts2), makeBuy(ts3)];
    expect(getHeldSince(WALLET, CREATOR, events)).toEqual(ts2);
  });

  it('handles mixed wallets and creators — returns earliest for the matching pair only', () => {
    const matchTs = new Date('2026-06-01T00:00:00Z');
    const otherWalletTs = new Date('2026-01-01T00:00:00Z');
    const otherCreatorTs = new Date('2026-02-01T00:00:00Z');
    const events = [
      makeBuy(matchTs),
      makeBuy(otherWalletTs, 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCD'),
      makeBuy(otherCreatorTs, WALLET, 'creator-other'),
    ];
    expect(getHeldSince(WALLET, CREATOR, events)).toEqual(matchTs);
  });
});
