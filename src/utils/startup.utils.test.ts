import { checkOptionalDependencies } from './startup.utils';
import { logger } from './logger.utils';
import { envConfig } from '../config';

jest.mock('./logger.utils', () => ({
   logger: {
      warn: jest.fn(),
   },
}));

jest.mock('../config', () => ({
   envConfig: {
      PAYSTACK_PUBLIC_KEY: undefined,
   },
}));

describe('Startup Utilities', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('should emit a structured warning with impact hints when optional dependencies are disabled', () => {
      checkOptionalDependencies();

      expect(logger.warn).toHaveBeenCalledWith(
         expect.objectContaining({
            disabledDependencies: expect.arrayContaining([
               expect.objectContaining({ dependency: 'Paystack Public Key' }),
            ]),
         }),
         'Server starting with optional dependencies disabled. Some features will have limited functionality.'
      );
   });

   it('should not emit a warning when all optional dependencies are present', () => {
      envConfig.PAYSTACK_PUBLIC_KEY = 'pk_test_123456789';

      checkOptionalDependencies();

      expect(logger.warn).not.toHaveBeenCalled();
   });
});
