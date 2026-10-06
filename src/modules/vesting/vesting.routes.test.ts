jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      indexedLedger: { findFirst: jest.fn() },
      creatorProfile: { findFirst: jest.fn() },
      stellarWallet: { findUnique: jest.fn() },
      vestingSchedule: { findMany: jest.fn() },
      vestingClaimHistory: { findMany: jest.fn() },
   },
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import keysRouter from '../keys/keys.routes';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { processVestingClaimEvent } from './vesting.service';

const creatorFindFirst = prisma.creatorProfile.findFirst as jest.Mock;
const walletFindUnique = prisma.stellarWallet.findUnique as jest.Mock;
const indexedLedgerFindFirst = prisma.indexedLedger.findFirst as jest.Mock;
const vestingScheduleFindMany = prisma.vestingSchedule.findMany as jest.Mock;
const vestingClaimHistoryFindMany = prisma.vestingClaimHistory.findMany as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1/keys', keysRouter);

function makeToken(wallet: string) {
   return jwt.sign({ sub: wallet, wallet }, envConfig.JWT_SECRET);
}

describe('GET /api/v1/keys/:keyId/vesting', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      creatorFindFirst.mockResolvedValue({ id: 'key-1', userId: 'user-1' });
      walletFindUnique.mockResolvedValue({ userId: 'user-1' });
      indexedLedgerFindFirst.mockResolvedValue({ ledger: 100 });
      vestingScheduleFindMany.mockResolvedValue([
         {
            id: 'v1',
            keyId: 'key-1',
            wallet: 'GTESTWALLET1234567890123456789012345678901234567890',
            totalKeys: '100',
            startLedger: 10,
            endLedger: 110,
            claimedKeys: '25',
         },
      ]);
   });

   it('returns the key vesting summary for the creator', async () => {
      const res = await request(app)
         .get('/api/v1/keys/key-1/vesting')
         .set('Authorization', `Bearer ${makeToken('GTESTWALLET1234567890123456789012345678901234567890')}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.keyId).toBe('key-1');
      expect(res.body.data.totalClaimableAmount).toBe('50');
      expect(res.body.data.cliffLedger).toBe(10);
      expect(res.body.data.durationLedger).toBe(100);
   });

   it('returns claimed history for the creator', async () => {
      vestingClaimHistoryFindMany.mockResolvedValue([
         {
            id: 'h1',
            keyId: 'key-1',
            wallet: 'GTESTWALLET1234567890123456789012345678901234567890',
            claimedAmount: '25',
            txHash: 'abc123',
            ledger: 75,
            claimedAt: new Date('2026-09-26T00:00:00Z'),
         },
      ]);

      const res = await request(app)
         .get('/api/v1/keys/key-1/vesting/history')
         .set('Authorization', `Bearer ${makeToken('GTESTWALLET1234567890123456789012345678901234567890')}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({
         keyId: 'key-1',
         claimedAmount: '25',
         txHash: 'abc123',
      });
   });
});

describe('processVestingClaimEvent', () => {
   it('creates a claim history record and invalidates the cache key', async () => {
      const createSpy = jest.fn().mockResolvedValue({ id: 'h1' });
      const invalidateSpy = jest.spyOn(require('./vesting.service'), 'invalidateKeyVestingCache');
      const findUniqueSpy = jest.spyOn(require('../../utils/prisma.utils').prisma.vestingSchedule, 'findUnique');
      const createHistorySpy = jest.spyOn(require('../../utils/prisma.utils').prisma.vestingClaimHistory, 'create');

      findUniqueSpy.mockResolvedValue({
         id: 'v1',
         keyId: 'key-1',
         wallet: 'GTESTWALLET1234567890123456789012345678901234567890',
      });
      createHistorySpy.mockImplementation(createSpy);
      invalidateSpy.mockResolvedValue(undefined);

      await processVestingClaimEvent({
         eventType: 'VestingClaimed',
         keyId: 'key-1',
         wallet: 'GTESTWALLET1234567890123456789012345678901234567890',
         claimedAmount: '25',
         txHash: 'abc123',
         ledger: 75,
      });

      expect(createSpy).toHaveBeenCalled();
      expect(invalidateSpy).toHaveBeenCalledWith('key-1');
   });
});
