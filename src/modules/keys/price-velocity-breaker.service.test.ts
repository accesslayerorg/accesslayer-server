// src/modules/keys/price-velocity-breaker.service.test.ts
// Unit tests for the key price velocity circuit breaker (#1195).

jest.mock('../../utils/audit.utils', () => ({
   emitAuditEvent: jest.fn(async () => undefined),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import { Keypair } from '@stellar/stellar-base';
import { emitAuditEvent } from '../../utils/audit.utils';
import {
   CIRCUIT_BREAKER_TRIGGERED_EVENT,
   BreakerKeyNotFoundError,
   BreakerNotTrippedError,
   ResetSignatureError,
   buildResetCanonicalMessage,
   checkPriceVelocityAfterTrade,
   computePriceVelocity,
   evaluatePriceVelocity,
   onCircuitBreakerReset,
   onCircuitBreakerTriggered,
   resetPriceVelocityBreaker,
   verifyResetSignature,
} from './price-velocity-breaker.service';

const config = { thresholdPct: 20, windowSize: 3 };
const trade = { creatorId: 'key-1', txHash: 'tx-9', ledger: 900 };

function makeDb(
   pricesNewestFirst: string[],
   openTrip: { id: string } | null = null
) {
   return {
      trade: {
         findMany: jest.fn(async ({ take }: { take: number }) =>
            pricesNewestFirst.slice(0, take).map(price => ({ price }))
         ),
      },
      creatorProfile: {
         findUnique: jest.fn(async () => ({ id: 'key-1' })),
         update: jest.fn(async () => ({})),
      },
      priceVelocityBreakerTrip: {
         findFirst: jest.fn(async () => openTrip),
         create: jest.fn(async () => ({ id: 'trip-1' })),
         updateMany: jest.fn(async () => ({ count: 1 })),
      },
   };
}

beforeEach(() => jest.clearAllMocks());

describe('computePriceVelocity', () => {
   it('follows (current - past) / past * 100', () => {
      expect(computePriceVelocity(150, 100)).toBe(50);
      expect(computePriceVelocity(75, 100)).toBe(-25);
      expect(computePriceVelocity(100, 100)).toBe(0);
   });

   it('has no velocity from a zero, negative or non-numeric reference', () => {
      expect(computePriceVelocity(10, 0)).toBeNull();
      expect(computePriceVelocity(10, -5)).toBeNull();
      expect(computePriceVelocity(Number('abc'), 10)).toBeNull();
   });
});

describe('evaluatePriceVelocity', () => {
   it('measures against the price exactly window_size trades ago', () => {
      // newest first: current 130, then 1, 2, 3 trades ago (100).
      const r = evaluatePriceVelocity(
         ['130', '125', '110', '100', '50'],
         config
      );
      expect(r.referencePrice).toBe('100');
      expect(r.velocityPct).toBe(30);
      expect(r.triggered).toBe(true);
   });

   it('respects a different configured window size', () => {
      const r = evaluatePriceVelocity(['130', '125', '110', '100'], {
         thresholdPct: 20,
         windowSize: 1,
      });
      expect(r.referencePrice).toBe('125');
      expect(r.velocityPct).toBeCloseTo(4);
      expect(r.triggered).toBe(false);
   });

   it('triggers on a crash as well as a spike', () => {
      const r = evaluatePriceVelocity(['70', '90', '95', '100'], config);
      expect(r.velocityPct).toBe(-30);
      expect(r.triggered).toBe(true);
   });

   it('does not trigger at exactly the threshold or below it', () => {
      expect(
         evaluatePriceVelocity(['120', '1', '1', '100'], config).triggered
      ).toBe(false);
      expect(
         evaluatePriceVelocity(['80', '1', '1', '100'], config).triggered
      ).toBe(false);
      expect(
         evaluatePriceVelocity(['119', '1', '1', '100'], config).triggered
      ).toBe(false);
   });

   it('does not trigger before window_size + 1 trades exist', () => {
      const r = evaluatePriceVelocity(['500', '100', '100'], config);
      expect(r.velocityPct).toBeNull();
      expect(r.triggered).toBe(false);
   });
});

describe('checkPriceVelocityAfterTrade', () => {
   it('pauses the key, records the trip and emits circuit_breaker_triggered', async () => {
      const db = makeDb(['150', '120', '110', '100']);
      const events: unknown[] = [];
      const off = onCircuitBreakerTriggered(e => events.push(e));
      const now = new Date('2026-11-21T09:00:00.000Z');

      const r = await checkPriceVelocityAfterTrade(db, trade, config, now);
      off();

      expect(r.triggered).toBe(true);
      expect(db.trade.findMany).toHaveBeenCalledWith(
         expect.objectContaining({ where: { creatorId: 'key-1' }, take: 4 })
      );
      expect(db.creatorProfile.update).toHaveBeenCalledWith({
         where: { id: 'key-1' },
         data: { tradingPaused: true },
      });
      expect(db.priceVelocityBreakerTrip.create).toHaveBeenCalledWith({
         data: expect.objectContaining({
            keyId: 'key-1',
            velocityPct: '50.000000',
            thresholdPct: '20.000000',
            windowSize: 3,
            currentPrice: '150',
            referencePrice: '100',
            tradeTxHash: 'tx-9',
            tradeLedger: 900,
            status: 'tripped',
         }),
      });
      expect(events).toEqual([
         {
            type: CIRCUIT_BREAKER_TRIGGERED_EVENT,
            keyId: 'key-1',
            velocityPct: 50,
            thresholdPct: 20,
            windowSize: 3,
            currentPrice: '150',
            referencePrice: '100',
            tradeTxHash: 'tx-9',
            tradeLedger: 900,
            triggeredAt: '2026-11-21T09:00:00.000Z',
         },
      ]);
      expect(emitAuditEvent).toHaveBeenCalledWith(
         expect.objectContaining({
            action: 'circuit_breaker_triggered',
            targetId: 'key-1',
            metadata: expect.objectContaining({
               velocityPct: 50,
               thresholdPct: 20,
            }),
         })
      );
   });

   it('pauses on a crash too', async () => {
      const db = makeDb(['60', '90', '95', '100']);
      const r = await checkPriceVelocityAfterTrade(db, trade, config);
      expect(r.velocityPct).toBe(-40);
      expect(db.creatorProfile.update).toHaveBeenCalledWith({
         where: { id: 'key-1' },
         data: { tradingPaused: true },
      });
   });

   it('leaves a key alone when velocity is within the threshold', async () => {
      const db = makeDb(['105', '102', '101', '100']);
      await checkPriceVelocityAfterTrade(db, trade, config);
      expect(db.creatorProfile.update).not.toHaveBeenCalled();
      expect(db.priceVelocityBreakerTrip.create).not.toHaveBeenCalled();
   });

   it('records one trip, not one per trade, while the breaker is tripped', async () => {
      const db = makeDb(['200', '150', '110', '100'], { id: 'trip-0' });
      await checkPriceVelocityAfterTrade(db, trade, config);
      expect(db.priceVelocityBreakerTrip.create).not.toHaveBeenCalled();
      expect(db.creatorProfile.update).not.toHaveBeenCalled();
   });
});

describe('verifyResetSignature', () => {
   const admin = Keypair.random();
   const outsider = Keypair.random();
   const now = 1_763_715_600_000;
   const timestamp = String(now - 1000);
   const sign = (kp: Keypair, keyId = 'key-1', ts = timestamp) =>
      kp.sign(buildResetCanonicalMessage(keyId, ts)).toString('base64');
   const base = {
      keyId: 'key-1',
      adminWallet: admin.publicKey(),
      timestamp,
      now,
      adminWallets: [admin.publicKey()],
   };

   it('accepts a fresh signature from a configured admin wallet', () => {
      expect(() =>
         verifyResetSignature({ ...base, signature: sign(admin) })
      ).not.toThrow();
   });

   it('rejects a signer that is not an admin wallet', () => {
      expect(() =>
         verifyResetSignature({
            ...base,
            adminWallet: outsider.publicKey(),
            signature: sign(outsider),
         })
      ).toThrow(ResetSignatureError);
   });

   it('fails closed when no admin wallets are configured', () => {
      expect(() =>
         verifyResetSignature({
            ...base,
            signature: sign(admin),
            adminWallets: [],
         })
      ).toThrow('No admin signer wallets are configured');
   });

   it('rejects a signature made for another key', () => {
      expect(() =>
         verifyResetSignature({ ...base, signature: sign(admin, 'key-2') })
      ).toThrow('Invalid admin signature');
   });

   it('rejects a wrong-key signature claimed by an admin address', () => {
      expect(() =>
         verifyResetSignature({ ...base, signature: sign(outsider) })
      ).toThrow('Invalid admin signature');
   });

   it('rejects an expired timestamp with 401 and a malformed signature with 400', () => {
      const old = String(now - 6 * 60 * 1000);
      try {
         verifyResetSignature({
            ...base,
            timestamp: old,
            signature: sign(admin, 'key-1', old),
         });
         throw new Error('expected rejection');
      } catch (e) {
         expect((e as ResetSignatureError).status).toBe(401);
      }
      try {
         verifyResetSignature({ ...base, signature: 'c2hvcnQ=' });
         throw new Error('expected rejection');
      } catch (e) {
         expect((e as ResetSignatureError).status).toBe(400);
      }
   });
});

describe('resetPriceVelocityBreaker', () => {
   it('closes the trip and restores trading', async () => {
      const db = makeDb([], { id: 'trip-1' });
      const events: unknown[] = [];
      const off = onCircuitBreakerReset(e => events.push(e));
      const now = new Date('2026-11-21T10:00:00.000Z');

      const r = await resetPriceVelocityBreaker(db, 'key-1', 'GADMIN', now);
      off();

      expect(r).toEqual({
         keyId: 'key-1',
         tradingPaused: false,
         resetTripId: 'trip-1',
         resetAt: '2026-11-21T10:00:00.000Z',
      });
      expect(db.priceVelocityBreakerTrip.updateMany).toHaveBeenCalledWith({
         where: { keyId: 'key-1', status: 'tripped' },
         data: { status: 'reset', resetByWallet: 'GADMIN', resetAt: now },
      });
      expect(db.creatorProfile.update).toHaveBeenCalledWith({
         where: { id: 'key-1' },
         data: { tradingPaused: false },
      });
      expect(events).toHaveLength(1);
   });

   it('refuses when the breaker is not tripped, leaving the pause alone', async () => {
      const db = makeDb([], null);
      await expect(
         resetPriceVelocityBreaker(db, 'key-1', 'GADMIN')
      ).rejects.toBeInstanceOf(BreakerNotTrippedError);
      expect(db.creatorProfile.update).not.toHaveBeenCalled();
   });

   it('404s an unknown key', async () => {
      const db = makeDb([], { id: 'trip-1' });
      db.creatorProfile.findUnique.mockResolvedValueOnce(null as never);
      await expect(
         resetPriceVelocityBreaker(db, 'nope', 'GADMIN')
      ).rejects.toBeInstanceOf(BreakerKeyNotFoundError);
   });
});
