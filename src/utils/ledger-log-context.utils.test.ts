import { ledgerLogContext } from './ledger-log-context.utils';

describe('ledgerLogContext', () => {
   it('should return ledger_sequence and ledger_timestamp fields', () => {
      const ledger = 12345678;
      const timestamp = new Date('2026-01-15T10:30:00.000Z');

      const result = ledgerLogContext(ledger, timestamp);

      expect(result).toEqual({
         ledger_sequence: 12345678,
         ledger_timestamp: '2026-01-15T10:30:00.000Z',
      });
   });

   it('should format timestamp as ISO 8601 UTC string', () => {
      const ledger = 99999999;
      const timestamp = new Date('2026-06-28T14:22:33.456Z');

      const result = ledgerLogContext(ledger, timestamp);

      expect(result.ledger_timestamp).toBe('2026-06-28T14:22:33.456Z');
      expect(result.ledger_timestamp).toMatch(
         /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      );
   });

   it('should preserve ledger sequence as number', () => {
      const ledger = 42;
      const timestamp = new Date();

      const result = ledgerLogContext(ledger, timestamp);

      expect(typeof result.ledger_sequence).toBe('number');
      expect(result.ledger_sequence).toBe(42);
   });

   it('should use UTC timezone regardless of local timezone', () => {
      const ledger = 1000000;
      // Create a date with explicit timezone offset
      const timestamp = new Date('2026-03-15T08:00:00+05:00'); // 03:00 UTC

      const result = ledgerLogContext(ledger, timestamp);

      // toISOString() always returns UTC
      expect(result.ledger_timestamp).toBe('2026-03-15T03:00:00.000Z');
   });

   it('should handle edge case ledger numbers', () => {
      const result1 = ledgerLogContext(0, new Date('2026-01-01T00:00:00Z'));
      expect(result1.ledger_sequence).toBe(0);

      const result2 = ledgerLogContext(Number.MAX_SAFE_INTEGER, new Date());
      expect(result2.ledger_sequence).toBe(Number.MAX_SAFE_INTEGER);
   });
});
