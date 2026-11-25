// Key LP reward accrual (#1196) driven against an in-memory DB so each
// acceptance criterion is checked on real state across several epochs.

jest.mock('../../config', () => ({
   envConfig: { LP_FEE_BPS: 100, LP_REWARD_ACCRUAL_MAX_CATCHUP_EPOCHS: 24 },
}));
jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../utils/prisma.utils', () => {
   const { createFakeLpDb } = jest.requireActual('./lp-rewards.fake-db');
   return { prisma: createFakeLpDb() };
});

import { prisma } from '../../utils/prisma.utils';
import type { FakeLpDb } from './lp-rewards.fake-db';
import {
   EpochAlreadyProcessedError,
   epochFloor,
   latestSettledEpochEnd,
   LP_REWARD_EPOCH_MS,
   processKeyLpRewardEpoch,
   runLpRewardAccrual,
} from './lp-reward-accrual.service';
import {
   claimKeyLpRewards,
   KeyLpDb,
   getKeyLpPosition,
   recordKeyLpDeposit,
   recordKeyLpWithdrawal,
} from './lp-rewards.service';

const db = prisma as unknown as FakeLpDb;
const tx = db as unknown as KeyLpDb;
const KEY = 'key-1';
const ALICE = 'GALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BOB = 'GBOBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CAROL = 'GCAROLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const H = LP_REWARD_EPOCH_MS;
const T0 = new Date('2026-11-22T10:00:00.000Z');
const at = (hours: number, minutes = 0) => new Date(T0.getTime() + hours * H + minutes * 60_000);
/** A run time just after the settle delay for the epoch ending at `hours`. */
const runAt = (hours: number) => at(hours, 2);

function addTrade(createdAt: Date, price: string, quantity: string, creatorId = KEY) {
   db.state.trades.push({ creatorId, price, quantity, createdAt });
}

function position(wallet: string) {
   return db.state.positions.find(p => p.keyId === KEY && p.wallet === wallet)!;
}

/** Seeds a pool cursor so the first processed epoch is [T0, T0+1h). */
function seedPool(keyId = KEY, lastEpochEnd = T0) {
   db.state.pools.push({ keyId, balance: '0', totalFunded: '0', totalDistributed: '0', lastEpochEnd });
}

beforeEach(() => {
   db.reset();
   db.state.creators.push({ id: KEY });
});

describe('epoch helpers', () => {
   it('floors to the UTC hour and waits out the settle delay', () => {
      expect(epochFloor(new Date('2026-11-22T10:59:59.999Z'))).toEqual(T0);
      expect(latestSettledEpochEnd(new Date('2026-11-22T11:00:30.000Z'))).toEqual(T0);
      expect(latestSettledEpochEnd(new Date('2026-11-22T11:01:00.000Z'))).toEqual(at(1));
   });
});

describe('pro-rata distribution per epoch', () => {
   it('funds the pool from LP_FEE_BPS of trade volume and splits it by eligible lp_tokens', async () => {
      seedPool();
      await recordKeyLpDeposit(tx, { keyId: KEY, wallet: ALICE, lpTokens: '100', at: at(-1) });
      await recordKeyLpDeposit(tx, { keyId: KEY, wallet: BOB, lpTokens: '300', at: at(-1) });
      // Both deposited before T0 and have already been rolled once.
      position(ALICE).eligibleLpTokens = '100.0000000';
      position(BOB).eligibleLpTokens = '300.0000000';

      // Volume 1_000_000 * 1 + 500 * 2_000 = 2_000_000; 100 bps -> 20_000.
      addTrade(at(0, 10), '1000000', '1');
      addTrade(at(0, 50), '500', '2000');
      addTrade(at(1, 5), '999999', '1'); // next epoch, not funded here

      const result = await processKeyLpRewardEpoch(KEY, T0, 100);

      expect(result).toMatchObject({
         tradeVolume: '2000000',
         fundedAmount: '20000',
         poolAmount: '20000',
         distributedAmount: '20000',
         carriedOverAmount: '0',
         totalEligibleLpTokens: '400.0000000',
         positionCount: 2,
      });
      expect(position(ALICE).accruedRewards).toBe('5000');
      expect(position(BOB).accruedRewards).toBe('15000');
      expect(db.state.accruals.map(a => a.amount).sort()).toEqual(['15000', '5000']);
      expect(db.state.pools[0]).toMatchObject({
         balance: '0',
         totalFunded: '20000',
         totalDistributed: '20000',
         lastEpochEnd: at(1),
      });
   });

   it('conserves the pool exactly when shares do not divide evenly', async () => {
      seedPool();
      for (const wallet of [ALICE, BOB, CAROL]) {
         await recordKeyLpDeposit(tx, { keyId: KEY, wallet, lpTokens: '1', at: at(-1) });
         position(wallet).eligibleLpTokens = '1.0000000';
      }
      addTrade(at(0, 1), '10000', '1'); // 100 bps -> 100 units

      const result = await processKeyLpRewardEpoch(KEY, T0, 100);

      const credited = [ALICE, BOB, CAROL].map(w => BigInt(position(w).accruedRewards));
      expect(credited.reduce((a, b) => a + b, 0n)).toBe(100n);
      expect(credited.every(c => c === 33n || c === 34n)).toBe(true);
      expect(result.carriedOverAmount).toBe('0');
   });

   it('carries the pool over when no liquidity is eligible yet', async () => {
      seedPool();
      addTrade(at(0, 1), '10000', '1');

      const result = await processKeyLpRewardEpoch(KEY, T0, 100);

      expect(result).toMatchObject({ fundedAmount: '100', distributedAmount: '0', carriedOverAmount: '100' });
      expect(db.state.pools[0].balance).toBe('100');
   });

   it('refuses to process the same epoch twice', async () => {
      seedPool();
      await processKeyLpRewardEpoch(KEY, T0, 100);
      await expect(processKeyLpRewardEpoch(KEY, T0, 100)).rejects.toBeInstanceOf(
         EpochAlreadyProcessedError
      );
      expect(db.state.epochs).toHaveLength(1);
   });
});

describe('new positions join the next epoch', () => {
   it('excludes a mid-epoch deposit from that epoch and includes it in the next', async () => {
      seedPool();
      await recordKeyLpDeposit(tx, { keyId: KEY, wallet: ALICE, lpTokens: '100', at: at(-1) });
      position(ALICE).eligibleLpTokens = '100.0000000';

      // Bob joins halfway through epoch 0.
      await recordKeyLpDeposit(tx, { keyId: KEY, wallet: BOB, lpTokens: '100', at: at(0, 30) });
      addTrade(at(0, 40), '10000', '1'); // 100 units
      await processKeyLpRewardEpoch(KEY, at(0), 100);

      expect(position(ALICE).accruedRewards).toBe('100');
      expect(position(BOB).accruedRewards).toBe('0');
      expect(position(BOB).eligibleLpTokens).toBe('100.0000000');

      addTrade(at(1, 10), '10000', '1'); // another 100 units
      await processKeyLpRewardEpoch(KEY, at(1), 100);

      expect(position(ALICE).accruedRewards).toBe('150');
      expect(position(BOB).accruedRewards).toBe('50');
   });

   it('does not roll a deposit that landed after the epoch ended (late job run)', async () => {
      seedPool();
      // Deposit at 11:00:30, after epoch [10:00, 11:00) closed but before it was processed.
      await recordKeyLpDeposit(tx, { keyId: KEY, wallet: BOB, lpTokens: '50', at: at(1, 0.5) });
      await processKeyLpRewardEpoch(KEY, at(0), 100);
      expect(position(BOB).eligibleLpTokens).toBe('0.0000000');

      await processKeyLpRewardEpoch(KEY, at(1), 100);
      expect(position(BOB).eligibleLpTokens).toBe('50.0000000');
   });

   it('stops a withdrawal from earning immediately', async () => {
      seedPool();
      await recordKeyLpDeposit(tx, { keyId: KEY, wallet: ALICE, lpTokens: '100', at: at(-1) });
      await recordKeyLpDeposit(tx, { keyId: KEY, wallet: BOB, lpTokens: '100', at: at(-1) });
      position(ALICE).eligibleLpTokens = '100.0000000';
      position(BOB).eligibleLpTokens = '100.0000000';

      await recordKeyLpWithdrawal(tx, { keyId: KEY, wallet: BOB, lpTokens: '75' });
      expect(position(BOB).eligibleLpTokens).toBe('25.0000000');

      addTrade(at(0, 10), '12500', '1'); // 125 units
      await processKeyLpRewardEpoch(KEY, T0, 100);

      expect(position(ALICE).accruedRewards).toBe('100');
      expect(position(BOB).accruedRewards).toBe('25');
   });
});

describe('runLpRewardAccrual', () => {
   it('updates every position of every key on schedule', async () => {
      db.state.creators.push({ id: 'key-2' });
      seedPool(KEY);
      seedPool('key-2');
      await recordKeyLpDeposit(tx, { keyId: KEY, wallet: ALICE, lpTokens: '10', at: at(-1) });
      await recordKeyLpDeposit(tx, { keyId: 'key-2', wallet: BOB, lpTokens: '10', at: at(-1) });

      const result = await runLpRewardAccrual(runAt(1), { lpFeeBps: 100 });

      expect(result).toMatchObject({ scannedKeys: 2, processedEpochs: 2, failedKeys: 0 });
      for (const p of db.state.positions) {
         expect(p.lastAccruedEpochEnd).toEqual(at(1));
      }
   });

   it('starts a newly seen key at the latest settled epoch and catches up missed epochs oldest first', async () => {
      addTrade(at(0, 5), '10000', '1');
      await runLpRewardAccrual(runAt(1), { lpFeeBps: 100 });
      expect(db.state.pools[0].lastEpochEnd).toEqual(at(1));
      expect(db.state.epochs.map(e => e.epochStart)).toEqual([at(0)]);

      // Job down for three hours.
      const result = await runLpRewardAccrual(runAt(4), { lpFeeBps: 100 });
      expect(result.processedEpochs).toBe(3);
      expect(db.state.epochs.map(e => e.epochStart)).toEqual([at(0), at(1), at(2), at(3)]);
   });

   it('caps catch-up per run and resumes on the next run', async () => {
      seedPool();
      await runLpRewardAccrual(runAt(5), { lpFeeBps: 100, maxEpochsPerKey: 2 });
      expect(db.state.pools[0].lastEpochEnd).toEqual(at(2));
      await runLpRewardAccrual(runAt(5), { lpFeeBps: 100, maxEpochsPerKey: 2 });
      expect(db.state.pools[0].lastEpochEnd).toEqual(at(4));
   });

   it('is a no-op when re-run inside the same epoch', async () => {
      seedPool();
      await runLpRewardAccrual(runAt(1), { lpFeeBps: 100 });
      const second = await runLpRewardAccrual(at(1, 30), { lpFeeBps: 100 });
      expect(second.processedEpochs).toBe(0);
      expect(db.state.epochs).toHaveLength(1);
   });
});

describe('claimable balance and claims', () => {
   async function accrue(): Promise<void> {
      seedPool();
      await recordKeyLpDeposit(tx, { keyId: KEY, wallet: ALICE, lpTokens: '100', price: '2', at: at(-1) });
      await recordKeyLpDeposit(tx, { keyId: KEY, wallet: BOB, lpTokens: '300', price: '2', at: at(-1) });
      position(ALICE).eligibleLpTokens = '100.0000000';
      position(BOB).eligibleLpTokens = '300.0000000';
      addTrade(at(0, 10), '40000', '1'); // 400 units
      await processKeyLpRewardEpoch(KEY, T0, 100);
   }

   it('reports lp_tokens, pool share, accrued and claimable', async () => {
      await accrue();
      const view = await getKeyLpPosition(KEY, ALICE);
      expect(view).toMatchObject({
         lpTokens: '100.0000000',
         entryPrice: '2.0000000',
         poolSharePct: '25.0000',
         accruedRewards: '100',
         claimedRewards: '0',
         claimable: '100',
         lastAccruedEpochEnd: at(1).toISOString(),
      });
   });

   it('transfers the claimable amount, records a payout and resets claimable to zero', async () => {
      await accrue();
      const claim = await claimKeyLpRewards(KEY, ALICE);

      expect(claim).toMatchObject({ amount: '100', claimable: '0', claimedRewards: '100', status: 'pending' });
      expect(db.state.claims).toEqual([
         expect.objectContaining({ keyId: KEY, wallet: ALICE, amount: '100', status: 'pending' }),
      ]);
      expect((await getKeyLpPosition(KEY, ALICE)).claimable).toBe('0');
      await expect(claimKeyLpRewards(KEY, ALICE)).rejects.toThrow('No claimable LP rewards');
   });

   it('reflects accrued minus claimed after further accrual', async () => {
      await accrue();
      await claimKeyLpRewards(KEY, ALICE);
      addTrade(at(1, 10), '40000', '1');
      await processKeyLpRewardEpoch(KEY, at(1), 100);

      const view = await getKeyLpPosition(KEY, ALICE);
      expect(view).toMatchObject({ accruedRewards: '200', claimedRewards: '100', claimable: '100' });
   });

   it('keeps accrued rewards claimable after a full withdrawal', async () => {
      await accrue();
      await recordKeyLpWithdrawal(tx, { keyId: KEY, wallet: BOB });
      const view = await getKeyLpPosition(KEY, BOB);
      expect(view).toMatchObject({ lpTokens: '0.0000000', poolSharePct: '0.0000', claimable: '300' });
   });

   it('rejects unknown keys and wallets without a position', async () => {
      await expect(getKeyLpPosition('nope', ALICE)).rejects.toThrow('Key not found');
      await expect(getKeyLpPosition(KEY, CAROL)).rejects.toThrow('No LP position');
      await expect(claimKeyLpRewards(KEY, CAROL)).rejects.toThrow('No LP position');
   });
});
