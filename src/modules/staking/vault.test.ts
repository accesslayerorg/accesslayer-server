import request from 'supertest';
import express from 'express';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import { prisma } from '../../utils/prisma.utils';
import { errorHandler } from '../../middlewares/error.middleware';
import { getSellUnitPrice } from '../../utils/pricing.utils';
import { processVaultEvents } from '../indexer/vault-indexer.service';
import stakingRouter from './vault.routes';

jest.mock('@prisma/client', () => {
   class PrismaClientKnownRequestError extends Error {
      code: string;
      constructor(message: string, opts: { code: string }) {
         super(message);
         this.code = opts.code;
      }
   }
   return { Prisma: { PrismaClientKnownRequestError }, PrismaClient: jest.fn() };
});

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      vaultPosition: {
         findMany: jest.fn(),
         groupBy: jest.fn(),
         aggregate: jest.fn(),
         findUnique: jest.fn(),
         upsert: jest.fn(),
      },
      vaultEventLog: { create: jest.fn() },
      creatorProfile: { findMany: jest.fn() },
      protocolConfig: { findUnique: jest.fn() },
      revenueClaim: { findUnique: jest.fn() },
      $transaction: jest.fn(),
   },
}));

jest.mock('../revenue/revenue.service', () => ({
   getLatestEndedCycle: jest.fn(),
   finalizeCycle: jest.fn(),
}));

import {
   finalizeCycle,
   getLatestEndedCycle,
} from '../revenue/revenue.service';

const app = express();
app.use(express.json());
app.use('/staking', stakingRouter);
app.use(errorHandler);

const ALICE = 'G' + 'A'.repeat(55);
const BOB = 'G' + 'B'.repeat(55);
const FEE_BPS = 500;
const unit = (supply: number) =>
   Number(getSellUnitPrice(supply, FEE_BPS)) / 10_000_000;

const db = prisma as any;
const auth = (wallet: string) => ({
   Authorization: `Bearer ${signWalletAccessToken(wallet)}`,
});

describe('Staking vault endpoints', () => {
   beforeEach(() => {
      jest.resetAllMocks();
      db.protocolConfig.findUnique.mockResolvedValue({ protocolFeeBps: FEE_BPS });
      db.creatorProfile.findMany.mockResolvedValue([
         { id: 'c1', circulatingSupply: 10 },
         { id: 'c2', circulatingSupply: 20 },
      ]);
   });

   it('requires auth for position and rewards, not for summary', async () => {
      expect((await request(app).get('/staking/vault/position')).status).toBe(401);
      expect((await request(app).get('/staking/vault/rewards')).status).toBe(401);
      db.vaultPosition.groupBy.mockResolvedValue([]);
      expect((await request(app).get('/staking/vault/summary')).status).toBe(200);
   });

   it('position returns the wallet share and per-key breakdown', async () => {
      // Alice: 4 of c1, 1 of c2. Bob: 6 of c1. Vault totals: c1=10, c2=1.
      db.vaultPosition.findMany.mockResolvedValue([
         { creatorId: 'c1', quantity: 4 },
         { creatorId: 'c2', quantity: 1 },
      ]);
      db.vaultPosition.groupBy.mockResolvedValue([
         { creatorId: 'c1', _sum: { quantity: 10 } },
         { creatorId: 'c2', _sum: { quantity: 1 } },
      ]);

      const res = await request(app)
         .get('/staking/vault/position')
         .set(auth(ALICE));

      const tvl = 10 * unit(10) + 1 * unit(20);
      const aliceValue = 4 * unit(10) + 1 * unit(20);
      expect(res.status).toBe(200);
      expect(res.body.data.keys).toHaveLength(2);
      expect(res.body.data.keys[0]).toMatchObject({ keyId: 'c1', quantity: 4 });
      expect(res.body.data.vaultTvlXlm).toBeCloseTo(tvl, 5);
      expect(res.body.data.totalValueXlm).toBeCloseTo(aliceValue, 5);
      expect(res.body.data.shareOfVault).toBeCloseTo(aliceValue / tvl, 5);
      // The wallet filter comes from the JWT, not the client.
      expect(db.vaultPosition.findMany.mock.calls[0][0].where.wallet).toBe(ALICE);
   });

   it('position is empty for a wallet with no deposits', async () => {
      db.vaultPosition.findMany.mockResolvedValue([]);
      db.vaultPosition.groupBy.mockResolvedValue([
         { creatorId: 'c1', _sum: { quantity: 10 } },
      ]);
      const res = await request(app)
         .get('/staking/vault/position')
         .set(auth(BOB));
      expect(res.body.data).toMatchObject({ shareOfVault: 0, keys: [] });
   });

   it('summary returns TVL and depositor count', async () => {
      db.vaultPosition.groupBy.mockImplementation((args: any) =>
         Promise.resolve(
            args.by[0] === 'creatorId'
               ? [
                    { creatorId: 'c1', _sum: { quantity: 10 } },
                    { creatorId: 'c2', _sum: { quantity: 1 } },
                 ]
               : [{ wallet: ALICE }, { wallet: BOB }]
         )
      );
      const res = await request(app).get('/staking/vault/summary');
      expect(res.status).toBe(200);
      expect(res.body.data.depositorCount).toBe(2);
      expect(res.body.data.keyCount).toBe(2);
      expect(res.body.data.tvlXlm).toBeCloseTo(10 * unit(10) + unit(20), 5);
   });

   describe('rewards', () => {
      const cycle = {
         id: 'cy1',
         cycleIndex: 3,
         startsAt: new Date('2026-04-01T00:00:00Z'),
         endsAt: new Date('2026-05-01T00:00:00Z'),
         totalFeesXlm: 100,
         distributedXlm: 0,
      };

      it('returns zero with no ended cycle', async () => {
         (getLatestEndedCycle as jest.Mock).mockReturnValue(null);
         const res = await request(app)
            .get('/staking/vault/rewards')
            .set(auth(ALICE));
         expect(res.body.data).toMatchObject({ claimableXlm: '0', cycle: null });
      });

      it('returns the vault-weighted share of the cycle pool', async () => {
         (getLatestEndedCycle as jest.Mock).mockReturnValue({ cycleIndex: 3 });
         (finalizeCycle as jest.Mock).mockResolvedValue(cycle);
         db.revenueClaim.findUnique.mockResolvedValue(null);
         db.vaultPosition.aggregate.mockImplementation((args: any) =>
            Promise.resolve({ _sum: { quantity: args.where.wallet ? 5 : 20 } })
         );
         const res = await request(app)
            .get('/staking/vault/rewards')
            .set(auth(ALICE));
         expect(res.status).toBe(200);
         expect(res.body.data.claimableXlm).toBe('25.0000000');
         expect(res.body.data.claimed).toBe(false);
      });

      it('returns zero once the cycle is already claimed', async () => {
         (getLatestEndedCycle as jest.Mock).mockReturnValue({ cycleIndex: 3 });
         (finalizeCycle as jest.Mock).mockResolvedValue(cycle);
         db.revenueClaim.findUnique.mockResolvedValue({ claimedAt: new Date() });
         const res = await request(app)
            .get('/staking/vault/rewards')
            .set(auth(ALICE));
         expect(res.body.data).toMatchObject({ claimableXlm: '0', claimed: true });
      });
   });

   describe('indexer sync', () => {
      let positions: Map<string, number>;
      let logged: Set<string>;

      beforeEach(() => {
         positions = new Map();
         logged = new Set();
         db.$transaction.mockImplementation((cb: any) => cb(db));
         db.vaultEventLog.create.mockImplementation(({ data }: any) => {
            const key = `${data.txHash}:${data.eventIndex}`;
            if (logged.has(key)) {
               const { Prisma } = jest.requireMock('@prisma/client');
               return Promise.reject(
                  new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002' })
               );
            }
            logged.add(key);
            return Promise.resolve({});
         });
         db.vaultPosition.findUnique.mockImplementation(({ where }: any) => {
            const k = `${where.wallet_creatorId.wallet}:${where.wallet_creatorId.creatorId}`;
            return Promise.resolve(
               positions.has(k) ? { quantity: positions.get(k) } : null
            );
         });
         db.vaultPosition.upsert.mockImplementation(({ where, create }: any) => {
            const k = `${where.wallet_creatorId.wallet}:${where.wallet_creatorId.creatorId}`;
            positions.set(k, Number(create.quantity));
            return Promise.resolve({});
         });
      });

      const ev = (
         eventType: string,
         eventIndex: number,
         quantity: string
      ): any => ({
         eventType,
         txHash: `tx${eventIndex}`,
         eventIndex,
         ledger: 100 + eventIndex,
         wallet: ALICE,
         creatorId: 'c1',
         quantity,
      });

      it('applies deposits and withdrawals, clamps at zero, ignores replays', async () => {
         const key = `${ALICE}:c1`;
         await processVaultEvents([ev('VAULT_DEPOSIT', 0, '10')]);
         expect(positions.get(key)).toBe(10);

         // Replay of the same event must not double count.
         await processVaultEvents([ev('VAULT_DEPOSIT', 0, '10')]);
         expect(positions.get(key)).toBe(10);

         await processVaultEvents([ev('VAULT_WITHDRAW', 1, '4')]);
         expect(positions.get(key)).toBe(6);

         await processVaultEvents([ev('VAULT_WITHDRAW', 2, '99')]);
         expect(positions.get(key)).toBe(0);
      });

      it('skips events with invalid quantity', async () => {
         await processVaultEvents([ev('VAULT_DEPOSIT', 5, '-3')]);
         expect(db.vaultEventLog.create).not.toHaveBeenCalled();
      });
   });
});
