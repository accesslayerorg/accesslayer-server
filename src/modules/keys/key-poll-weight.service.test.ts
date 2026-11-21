// src/modules/keys/key-poll-weight.service.test.ts (#1154)
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      governanceProposal: { findFirst: jest.fn() },
      keyOwnership: { findUnique: jest.fn() },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   getPollVoteWeight,
   PollNotFoundError,
   pollWeightCacheKey,
   POLL_WEIGHT_CACHE_SECONDS,
} from './key-poll-weight.service';

const findFirst = prisma.governanceProposal.findFirst as jest.Mock;
const findUnique = prisma.keyOwnership.findUnique as jest.Mock;

const KEY_ID = 'key-1';
const POLL_ID = 'prop-1';
const WALLET = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS2345';

describe('getPollVoteWeight', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      findFirst.mockResolvedValue({ snapshotLedger: 4821 });
      findUnique.mockResolvedValue({ balance: '120' });
   });

   it('returns the holder balance at the poll snapshot block', async () => {
      const result = await getPollVoteWeight(KEY_ID, POLL_ID, WALLET);

      expect(result).toEqual({
         vote_weight: '120',
         snapshot_block: 4821,
      });
      expect(findFirst).toHaveBeenCalledWith({
         where: { keyId: KEY_ID, proposalId: POLL_ID },
         select: { snapshotLedger: true },
      });
      expect(findUnique).toHaveBeenCalledWith({
         where: {
            ownerAddress_creatorId: {
               ownerAddress: WALLET,
               creatorId: KEY_ID,
            },
         },
         select: { balance: true },
      });
   });

   it('returns zero weight when the wallet has no holdings row', async () => {
      findUnique.mockResolvedValue(null);

      await expect(
         getPollVoteWeight(KEY_ID, POLL_ID, WALLET)
      ).resolves.toEqual({ vote_weight: '0', snapshot_block: 4821 });
   });

   it('returns zero weight when the snapshot balance is zero', async () => {
      findUnique.mockResolvedValue({ balance: '0' });

      await expect(
         getPollVoteWeight(KEY_ID, POLL_ID, WALLET)
      ).resolves.toEqual({ vote_weight: '0', snapshot_block: 4821 });
   });

   it('throws PollNotFoundError when the poll is not on this key', async () => {
      findFirst.mockResolvedValue(null);

      await expect(
         getPollVoteWeight(KEY_ID, POLL_ID, WALLET)
      ).rejects.toBeInstanceOf(PollNotFoundError);
      expect(findUnique).not.toHaveBeenCalled();
   });
});

describe('poll weight cache', () => {
   it('caches 60s per wallet/poll pair', () => {
      expect(POLL_WEIGHT_CACHE_SECONDS).toBe(60);
      expect(pollWeightCacheKey(KEY_ID, POLL_ID, WALLET)).toBe(
         `key:poll:weight:${KEY_ID}:${POLL_ID}:${WALLET}`
      );
      expect(pollWeightCacheKey(KEY_ID, 'prop-2', WALLET)).not.toBe(
         pollWeightCacheKey(KEY_ID, POLL_ID, WALLET)
      );
      expect(pollWeightCacheKey(KEY_ID, POLL_ID, `${WALLET}X`)).not.toBe(
         pollWeightCacheKey(KEY_ID, POLL_ID, WALLET)
      );
   });
});
