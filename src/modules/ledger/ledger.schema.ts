/**
 * Response shape for the ledger status endpoint.
 */
export interface LedgerStatusResponse {
  /** Whether the request was successful */
  success: boolean;
  /** Ledger status data */
  data: {
    /** Latest indexed ledger number */
    ledger: number;
    /** Opaque cursor for the latest ledger */
    cursor: string;
    /** ISO timestamp of the last successful sync */
    updatedAt: string | null;
  };
}
