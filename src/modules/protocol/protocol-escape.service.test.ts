import { Decimal } from '@prisma/client/runtime/library';
import { computeEscapeStatus, estimateRecoverable } from './protocol-escape.service';

jest.mock('../../config', () => ({
   envConfig: { PROTOCOL_ESCAPE_DELAY_LEDGERS: 100 },
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {},
}));

const pausedAt = new Date('2026-11-20T12:00:00.000Z');

describe('computeEscapeStatus', () => {
   it('reports no pause and inactive escape when the latest event is not a pause', () => {
      const status = computeEscapeStatus({
         latestPause: { kind: 'unpaused', ledger: 900, occurredAt: pausedAt },
         currentLedger: 2000,
         delayLedgers: 100,
      });

      expect(status).toEqual({
         pausedSince: null,
         escapeEnabledAtLedger: null,
         active: false,
         currentLedger: 2000,
      });
   });

   it('becomes active only once the configured delay has elapsed', () => {
      const latestPause = { kind: 'paused', ledger: 1000, occurredAt: pausedAt };

      const beforeDelay = computeEscapeStatus({
         latestPause,
         currentLedger: 1099,
         delayLedgers: 100,
      });
      expect(beforeDelay.escapeEnabledAtLedger).toBe(1100);
      expect(beforeDelay.active).toBe(false);
      expect(beforeDelay.pausedSince).toBe(pausedAt.toISOString());

      const atDelay = computeEscapeStatus({
         latestPause,
         currentLedger: 1100,
         delayLedgers: 100,
      });
      expect(atDelay.active).toBe(true);
   });

   it('stays inactive when the indexed ledger is unknown', () => {
      const status = computeEscapeStatus({
         latestPause: { kind: 'paused', ledger: 1000, occurredAt: pausedAt },
         currentLedger: null,
         delayLedgers: 0,
      });

      expect(status.active).toBe(false);
      expect(status.escapeEnabledAtLedger).toBe(1000);
   });
});

describe('estimateRecoverable', () => {
   it('equals balance over supply times reserve', () => {
      const estimate = estimateRecoverable(
         new Decimal(25),
         new Decimal(100),
         new Decimal(40)
      );

      expect(estimate.toFixed(7)).toBe('10.0000000');
   });

   it('rounds down to seven decimal places', () => {
      const estimate = estimateRecoverable(
         new Decimal(1),
         new Decimal(3),
         new Decimal(1)
      );

      expect(estimate.toFixed(7)).toBe('0.3333333');
   });

   it('returns zero when supply is zero', () => {
      const estimate = estimateRecoverable(
         new Decimal(5),
         new Decimal(0),
         new Decimal(40)
      );

      expect(estimate.toFixed(7)).toBe('0.0000000');
   });
});
