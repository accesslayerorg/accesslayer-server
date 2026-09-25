import { logger } from '../../utils/logger.utils';

export interface SubmitTransactionResult {
   success: boolean;
   hash?: string;
   error_code?: string;
   xdr?: string; // Should be excluded from logs
}

/**
 * Placeholder for the real submitTransaction logic that will be merged later.
 * It simulates a failed transaction submission and logs it.
 */
export async function submitTransaction(
   walletAddress: string,
   _xdr: string
): Promise<SubmitTransactionResult> {
   try {
      // Placeholder: simulate a failed transaction
      throw new Error('tx_failed');
   } catch (error: any) {
      // Issue #696: Add structured log for failed Stellar transaction
      logger.warn(
         {
            operation: 'submit_transaction',
            error_code: error.message || 'unknown_error',
            tx_hash: null, // Available if it was a timeout or partial failure
            wallet: walletAddress,
            failed_at: new Date().toISOString(),
         },
         'Stellar transaction submission failed'
      );

      return {
         success: false,
         error_code: error.message || 'unknown_error',
      };
   }
}
