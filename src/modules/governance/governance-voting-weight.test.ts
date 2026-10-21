import express from 'express';
import request from 'supertest';
import governanceRouter from './governance.routes';
import { getKeyGovernanceVotingWeight } from './governance-delegation.service';
import {
   processDelegationRevokedEvents,
   processDelegationSetEvents,
} from './governance-delegation-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';

const mockCache = new Map<string, string>();

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => {
      const raw = mockCache.get(key);
      return raw === undefined ? null : JSON.parse(raw);
   }),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => {
      mockCache.set(key, JSON.stringify(value));
   }),
   cacheInvalidate: jest.fn(async (...patterns: string[]) => {
      for (const pattern of patterns) {
         const prefix = pattern.replace(/\*$/, '');
         for (const k of Array.from(mockCache.keys())) {
            if (k.startsWith(prefix)) mockCache.delete(k);
         }
      }
   }),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyOwnership: {
         findUnique: jest.fn(),
         findMany: jest.fn(),
      },
      voteDelegation: {
         findMany: jest.fn(),
         findUnique: jest.fn(),
         upsert: jest.fn(),
         update: jest.fn(),
      },
      voteDelegationHistory: {
         findUnique: jest.fn(),
         create: jest.fn(),
      },
      activity: {
         create: jest.fn(),
      },
      $transaction: jest.fn(async (ops: Array<Promise<unknown>>) =>
         Promise.all(ops)
      ),
   },
}));

const app = express();
app.use(express.json());
app.use('/governance', governanceRouter);

const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const DELEGATOR_1 = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF';
const DELEGATOR_2 = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF';

beforeEach(() => {
   jest.clearAllMocks();
   mockCache.clear();
});

describe('GET /governance/voting-weight/:wallet/:key_id (#1176)', () => {
   it('computes own_weight, delegated_weight, total, and delegators list accurately', async () => {
      (prisma.keyOwnership.findUnique as jest.Mock).mockResolvedValue({
         balance: '40',
      });
      (prisma.voteDelegation.findMany as jest.Mock).mockResolvedValue([
         { delegatorWallet: DELEGATOR_1 },
         { delegatorWallet: DELEGATOR_2 },
      ]);
      (prisma.keyOwnership.findMany as jest.Mock).mockResolvedValue([
         { ownerAddress: DELEGATOR_1, balance: '25' },
         { ownerAddress: DELEGATOR_2, balance: '35' },
      ]);

      const res = await request(app).get(
         `/governance/voting-weight/${WALLET}/key-1`
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
         wallet: WALLET,
         key_id: 'key-1',
         own_weight: 40,
         delegated_weight: 60,
         total: 100,
         delegators: [
            { wallet: DELEGATOR_1, amount: 25 },
            { wallet: DELEGATOR_2, amount: 35 },
         ],
      });
      expect(cacheSetJson).toHaveBeenCalledWith(
         `governance:voting-weight:${WALLET}:key-1`,
         expect.any(Object),
         60
      );
   });

   it('returns total: 0 for wallets with no holdings and no delegations', async () => {
      (prisma.keyOwnership.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.voteDelegation.findMany as jest.Mock).mockResolvedValue([]);

      const result = await getKeyGovernanceVotingWeight(WALLET, 'key-empty');

      expect(result).toEqual({
         wallet: WALLET,
         key_id: 'key-empty',
         own_weight: 0,
         delegated_weight: 0,
         total: 0,
         delegators: [],
      });
   });

   it('invalidates cached voting weight on VotingDelegated and DelegationRevoked events', async () => {
      (prisma.voteDelegationHistory.findUnique as jest.Mock).mockResolvedValue(
         null
      );
      (prisma.voteDelegation.findUnique as jest.Mock).mockResolvedValue(null);

      await processDelegationSetEvents([
         {
            eventType: 'VotingDelegated',
            delegatorWallet: DELEGATOR_1,
            delegateeWallet: WALLET,
            keyId: 'key-1',
            occurredAt: '2026-10-21T12:00:00.000Z',
            ledger: 800,
            txHash: 'tx-del-1',
            eventIndex: 0,
         },
      ]);

      expect(cacheInvalidate).toHaveBeenCalledWith(
         expect.any(String),
         expect.any(String),
         expect.any(String),
         expect.any(String),
         `governance:voting-weight:${DELEGATOR_1}:*`,
         `governance:voting-weight:${WALLET}:*`
      );

      (prisma.voteDelegation.findUnique as jest.Mock).mockResolvedValue({
         id: 'del-row-1',
         delegateeWallet: WALLET,
         isActive: true,
      });

      await processDelegationRevokedEvents([
         {
            eventType: 'DelegationRevoked',
            delegatorWallet: DELEGATOR_1,
            keyId: 'key-1',
            occurredAt: '2026-10-21T12:05:00.000Z',
            ledger: 801,
            txHash: 'tx-del-2',
            eventIndex: 0,
         },
      ]);

      expect(cacheGetJson).not.toThrow();
      expect(cacheInvalidate).toHaveBeenLastCalledWith(
         expect.any(String),
         expect.any(String),
         expect.any(String),
         expect.any(String),
         `governance:voting-weight:${DELEGATOR_1}:*`,
         `governance:voting-weight:${WALLET}:*`
      );
   });
});
