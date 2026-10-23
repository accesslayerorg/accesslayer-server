// src/modules/badges/__tests__/badge-mint.service.test.ts

jest.mock('../../../config', () => ({
   envConfig: {
      BADGE_WHALE_THRESHOLD_XLM: 10000,
      BADGE_HOLD_MILESTONE_DAYS: 365,
      BADGE_TOP_TRADER_MAX_RANK: 10,
      BADGE_MINT_MAX_ATTEMPTS: 3,
   },
}));

jest.mock('../../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import { mintBadge } from '../badge-mint.service';
import type { BadgeMintContractClient } from '../badge.types';

describe('Badge Mint Service', () => {
   const now = new Date('2026-10-21T12:00:00.000Z');

   const mockPrisma = {
      badgeMintLog: {
         findUnique: jest.fn(),
         upsert: jest.fn(),
      },
   };

   let mockContractClient: BadgeMintContractClient;

   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.badgeMintLog.findUnique.mockResolvedValue(null);
      mockPrisma.badgeMintLog.upsert.mockResolvedValue({});
      mockContractClient = {
         mintBadge: jest.fn().mockResolvedValue({ txHash: 'tx-abc' }),
      };
   });

   const deps = (overrides = {}) => ({
      prisma: mockPrisma as any,
      contractClient: mockContractClient,
      now: () => now,
      delay: jest.fn().mockResolvedValue(undefined),
      baseDelayMs: 1,
      ...overrides,
   });

   it('mints a badge and records it as MINTED in badge_mint_log', async () => {
      const result = await mintBadge(
         'GWALLET1',
         'FIRST_BUYER',
         'first_swap',
         deps()
      );

      expect(result).toEqual({
         wallet: 'GWALLET1',
         badgeType: 'FIRST_BUYER',
         status: 'MINTED',
         txHash: 'tx-abc',
         attempts: 1,
      });
      expect(mockContractClient.mintBadge).toHaveBeenCalledTimes(1);
      expect(mockContractClient.mintBadge).toHaveBeenCalledWith(
         'GWALLET1',
         'FIRST_BUYER'
      );
      expect(mockPrisma.badgeMintLog.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            where: {
               wallet_badgeType: {
                  wallet: 'GWALLET1',
                  badgeType: 'FIRST_BUYER',
               },
            },
            create: expect.objectContaining({
               status: 'MINTED',
               txHash: 'tx-abc',
               triggerEvent: 'first_swap',
               attempts: 1,
               mintedAt: now,
            }),
         })
      );
   });

   it('deduplicates: skips minting when the badge is already MINTED', async () => {
      mockPrisma.badgeMintLog.findUnique.mockResolvedValueOnce({
         status: 'MINTED',
         txHash: 'tx-existing',
         attempts: 1,
      });

      const result = await mintBadge(
         'GWALLET1',
         'WHALE_HOLDER',
         'whale_swap',
         deps()
      );

      expect(result).toEqual({
         wallet: 'GWALLET1',
         badgeType: 'WHALE_HOLDER',
         status: 'SKIPPED',
         reason: 'already_earned',
         txHash: 'tx-existing',
         attempts: 1,
      });
      // No contract call and no new log write for an already-earned badge.
      expect(mockContractClient.mintBadge).not.toHaveBeenCalled();
      expect(mockPrisma.badgeMintLog.upsert).not.toHaveBeenCalled();
   });

   it('retries transient mint failures and succeeds on a later attempt', async () => {
      mockContractClient.mintBadge = jest
         .fn()
         .mockRejectedValueOnce(
            Object.assign(new Error('RPC timeout'), { kind: 'transient' })
         )
         .mockRejectedValueOnce(new Error('connection reset')) // unknown => transient
         .mockResolvedValueOnce({ txHash: 'tx-after-retry' });

      const delay = jest.fn().mockResolvedValue(undefined);
      const result = await mintBadge(
         'GWALLET2',
         'FIRST_BUYER',
         'first_swap',
         deps({ delay })
      );

      expect(result.status).toBe('MINTED');
      expect(result.txHash).toBe('tx-after-retry');
      expect(result.attempts).toBe(3);
      expect(mockContractClient.mintBadge).toHaveBeenCalledTimes(3);
      expect(delay).toHaveBeenCalledTimes(2); // backoff between the 3 attempts
   });

   it('gives up after exhausting attempts on persistent transient failures', async () => {
      mockContractClient.mintBadge = jest
         .fn()
         .mockRejectedValue(
            Object.assign(new Error('node unavailable'), { kind: 'transient' })
         );

      const result = await mintBadge(
         'GWALLET3',
         'FIRST_BUYER',
         'first_swap',
         deps({ maxAttempts: 3 })
      );

      expect(result.status).toBe('FAILED');
      expect(result.attempts).toBe(3);
      expect(result.error).toBe('node unavailable');
      expect(mockContractClient.mintBadge).toHaveBeenCalledTimes(3);
      expect(mockPrisma.badgeMintLog.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            create: expect.objectContaining({
               status: 'FAILED',
               error: 'node unavailable',
               attempts: 3,
            }),
         })
      );
   });

   it('does not retry user-kind failures (terminal immediately)', async () => {
      mockContractClient.mintBadge = jest
         .fn()
         .mockRejectedValue(
            Object.assign(new Error('unauthorized'), { kind: 'user' })
         );

      const result = await mintBadge(
         'GWALLET4',
         'FIRST_BUYER',
         'first_swap',
         deps()
      );

      expect(result.status).toBe('FAILED');
      expect(result.attempts).toBe(1);
      expect(mockContractClient.mintBadge).toHaveBeenCalledTimes(1);
   });

   it('re-attempts a badge whose previous mint FAILED (not deduped)', async () => {
      mockPrisma.badgeMintLog.findUnique.mockResolvedValueOnce({
         status: 'FAILED',
         txHash: null,
         attempts: 2,
      });

      const result = await mintBadge(
         'GWALLET5',
         'GOVERNANCE_VOTER',
         'vote_cast',
         deps()
      );

      expect(result.status).toBe('MINTED');
      expect(mockContractClient.mintBadge).toHaveBeenCalledTimes(1);
   });
});
