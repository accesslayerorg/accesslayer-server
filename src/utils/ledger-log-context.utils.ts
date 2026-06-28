/**
 * Creates a standard structured log context object for ledger sequence and timestamp.
 *
 * This helper ensures consistent formatting of ledger context across all log entries
 * that include both ledger sequence numbers and their associated timestamps.
 *
 * @param ledger - The ledger sequence number
 * @param timestamp - The ledger close timestamp
 * @returns Object with ledger_sequence (number) and ledger_timestamp (ISO 8601 UTC string)
 *
 * @example
 * logger.info({
 *   ...ledgerLogContext(12345678, new Date('2026-01-15T10:30:00Z')),
 *   trade_amount: 100
 * }, 'Trade processed');
 * // Logs: { ledger_sequence: 12345678, ledger_timestamp: '2026-01-15T10:30:00.000Z', trade_amount: 100 }
 */
export function ledgerLogContext(
   ledger: number,
   timestamp: Date
): { ledger_sequence: number; ledger_timestamp: string } {
   return {
      ledger_sequence: ledger,
      ledger_timestamp: timestamp.toISOString(),
   };
}
