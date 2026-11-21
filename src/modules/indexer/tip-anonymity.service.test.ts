import { prisma } from '../../utils/prisma.utils';
import { parseTipEvent, processTipEvent } from './tip-indexer.service';
import { cacheInvalidate } from '../../utils/redis.utils';

jest.mock('../../utils/redis.utils', () => ({
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../whitelist/whitelist.service', () => ({ resolveCreatorId: jest.fn().mockResolvedValue('key-1') }));
const event = (anonymous?: unknown) => ({
   eventType: 'TipSent', keyId: 'key-1', tipper: 'wallet-1',
   amount: '10000000', ledger: 1, eventIndex: 0, txHash: 'tx-1',
   tippedAt: '2026-11-21T00:00:00Z',
   ...(anonymous === undefined ? {} : { anonymous }),
});

describe('anonymous TipSent persistence', () => {
   beforeEach(() => jest.clearAllMocks());

   it('defaults older events to public tips', () => {
      const result = parseTipEvent(event());
      expect(result.ok && result.value.anonymous).toBe(false);
   });

   it('accepts boolean anonymity and rejects ambiguous values', () => {
      const result = parseTipEvent(event(true));
      expect(result.ok && result.value.anonymous).toBe(true);
      expect(parseTipEvent(event('false')).ok).toBe(false);
   });

   it('persists the flag and invalidates all cached tip responses', async () => {
      await processTipEvent(event(true));
      expect(prisma.keyTip.create).toHaveBeenCalledWith(expect.objectContaining({
         data: expect.objectContaining({ anonymous: true }),
      }));
      expect(cacheInvalidate).toHaveBeenCalledWith('key:tips:key-1:*');
   });

   it('writes alias-key tips under the canonical key used by the leaderboard', async () => {
      await processTipEvent({ ...event(false), keyId: 'alias' });
      expect(prisma.keyTip.create).toHaveBeenCalledWith(expect.objectContaining({
         data: expect.objectContaining({ keyId: 'key-1' }),
      }));
      expect(cacheInvalidate).toHaveBeenCalledWith('key:tips:key-1:*');
   });

   it('also invalidates cache after a replay without adding to totals', async () => {
      (prisma.keyTip.create as jest.Mock).mockRejectedValueOnce({ code: 'P2002' });
      expect(await processTipEvent(event(true))).toBe(false);
      expect(prisma.keyTipTotal.upsert).not.toHaveBeenCalled();
      expect(cacheInvalidate).toHaveBeenCalledWith('key:tips:key-1:*');
   });
});
