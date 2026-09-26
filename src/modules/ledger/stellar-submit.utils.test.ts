import { submitTransaction } from './stellar-submit.utils';
import { logger } from '../../utils/logger.utils';

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      warn: jest.fn(),
   },
}));

describe('submitTransaction', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('logs structured data without XDR on failure', async () => {
      const wallet = 'GABC1234';
      const xdr = 'AAAAAAAABBBBBB...'; // Dummy XDR

      const result = await submitTransaction(wallet, xdr);

      expect(result.success).toBe(false);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      const [logFields, message] = (logger.warn as jest.Mock).mock.calls[0];

      expect(message).toBe('Stellar transaction submission failed');
      expect(logFields).toHaveProperty('operation', 'submit_transaction');
      expect(logFields).toHaveProperty('error_code', 'tx_failed');
      expect(logFields).toHaveProperty('tx_hash');
      expect(logFields).toHaveProperty('wallet', wallet);
      expect(logFields).toHaveProperty('failed_at');

      // Explicitly check that XDR is excluded
      expect(logFields).not.toHaveProperty('xdr');
   });
});
