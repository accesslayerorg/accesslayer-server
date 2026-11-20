// src/modules/badges/__tests__/badge-trigger.service.test.ts

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

import {
   evaluateEvent,
   processQualifyingEvent,
} from '../badge-trigger.service';
import type { BadgeMintContractClient } from '../badge.types';

describe('Badge Trigger Service', () => {
   describe('evaluateEvent (qualification rules)', () => {
      it('first swap earns FIRST_BUYER', () => {
         const awards = evaluateEvent({
            kind: 'swap',
            wallet: 'G1',
            amount: 5,
            isFirstSwap: true,
         });
         expect(awards.map(a => a.badgeType)).toEqual(['FIRST_BUYER']);
         expect(awards[0].triggerEvent).toBe('first_swap');
      });

      it('whale-sized swap earns WHALE_HOLDER', () => {
         const awards = evaluateEvent({
            kind: 'swap',
            wallet: 'G1',
            amount: 10000,
            isFirstSwap: false,
         });
         expect(awards.map(a => a.badgeType)).toEqual(['WHALE_HOLDER']);
      });

      it('a first swap that is also whale-sized earns both badges', () => {
         const awards = evaluateEvent({
            kind: 'swap',
            wallet: 'G1',
            amount: 25000,
            isFirstSwap: true,
         });
         expect(awards.map(a => a.badgeType)).toEqual([
            'FIRST_BUYER',
            'WHALE_HOLDER',
         ]);
      });

      it('a small non-first swap earns nothing', () => {
         const awards = evaluateEvent({
            kind: 'swap',
            wallet: 'G1',
            amount: 9999,
            isFirstSwap: false,
         });
         expect(awards).toEqual([]);
      });

      it('a vote earns GOVERNANCE_VOTER', () => {
         const awards = evaluateEvent({
            kind: 'vote',
            wallet: 'G1',
            proposalId: 'prop-1',
         });
         expect(awards.map(a => a.badgeType)).toEqual(['GOVERNANCE_VOTER']);
      });

      it('a 365d hold earns DIAMOND_HANDS, a shorter hold does not', () => {
         expect(
            evaluateEvent({
               kind: 'hold',
               wallet: 'G1',
               holdDurationDays: 365,
            }).map(a => a.badgeType)
         ).toEqual(['DIAMOND_HANDS']);

         expect(
            evaluateEvent({
               kind: 'hold',
               wallet: 'G1',
               holdDurationDays: 364,
            })
         ).toEqual([]);
      });

      it('a top-10 leaderboard entry earns TOP_TRADER, rank 11 does not', () => {
         expect(
            evaluateEvent({ kind: 'leaderboard', wallet: 'G1', rank: 10 }).map(
               a => a.badgeType
            )
         ).toEqual(['TOP_TRADER']);

         expect(
            evaluateEvent({ kind: 'leaderboard', wallet: 'G1', rank: 11 })
         ).toEqual([]);
      });
   });

   describe('processQualifyingEvent (mint dispatch)', () => {
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
            mintBadge: jest.fn().mockResolvedValue({ txHash: 'tx-1' }),
         };
      });

      const deps = () => ({
         prisma: mockPrisma as any,
         contractClient: mockContractClient,
         delay: jest.fn().mockResolvedValue(undefined),
         baseDelayMs: 1,
      });

      it('first swap triggers a FIRST_BUYER mint', async () => {
         const result = await processQualifyingEvent(
            { kind: 'swap', wallet: 'GBUYER', amount: 5, isFirstSwap: true },
            deps()
         );

         expect(result.awards).toHaveLength(1);
         expect(result.awards[0]).toMatchObject({
            badgeType: 'FIRST_BUYER',
            status: 'MINTED',
         });
         expect(mockContractClient.mintBadge).toHaveBeenCalledWith(
            'GBUYER',
            'FIRST_BUYER'
         );
      });

      it('whale swap triggers a WHALE_HOLDER mint', async () => {
         const result = await processQualifyingEvent(
            {
               kind: 'swap',
               wallet: 'GWHALE',
               amount: 50000,
               isFirstSwap: false,
            },
            deps()
         );

         expect(result.awards.map(a => a.badgeType)).toEqual(['WHALE_HOLDER']);
         expect(mockContractClient.mintBadge).toHaveBeenCalledWith(
            'GWHALE',
            'WHALE_HOLDER'
         );
      });

      it('governance vote triggers a GOVERNANCE_VOTER mint', async () => {
         const result = await processQualifyingEvent(
            { kind: 'vote', wallet: 'GVOTER', proposalId: 'p-9' },
            deps()
         );

         expect(result.awards.map(a => a.badgeType)).toEqual([
            'GOVERNANCE_VOTER',
         ]);
         expect(mockContractClient.mintBadge).toHaveBeenCalledWith(
            'GVOTER',
            'GOVERNANCE_VOTER'
         );
      });

      it('does nothing for a non-qualifying event', async () => {
         const result = await processQualifyingEvent(
            { kind: 'leaderboard', wallet: 'GX', rank: 99 },
            deps()
         );

         expect(result.awards).toEqual([]);
         expect(mockContractClient.mintBadge).not.toHaveBeenCalled();
      });

      it('deduplicates an already-earned badge on reprocessing', async () => {
         mockPrisma.badgeMintLog.findUnique.mockResolvedValueOnce({
            status: 'MINTED',
            txHash: 'tx-old',
            attempts: 1,
         });

         const result = await processQualifyingEvent(
            { kind: 'vote', wallet: 'GVOTER', proposalId: 'p-9' },
            deps()
         );

         expect(result.awards[0].status).toBe('SKIPPED');
         expect(mockContractClient.mintBadge).not.toHaveBeenCalled();
      });
   });
});
