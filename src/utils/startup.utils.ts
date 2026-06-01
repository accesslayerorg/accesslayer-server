import { envConfig } from '../config';
import { logger } from './logger.utils';

export function checkOptionalDependencies(): void {
   const disabledFeatures: Array<{ dependency: string; impact: string }> = [];

   // Gmail credentials are technically optional (no min length enforced)
   if (!envConfig.GMAIL_USER || !envConfig.GMAIL_APP_PASSWORD) {
      disabledFeatures.push({
         dependency: 'Email Transport (Gmail)',
         impact:
            'Transactional emails will not be sent. Email-based flows (e.g., test emails) will fail.',
      });
   }

   // Paystack Public Key is explicitly optional in the schema
   if (!envConfig.PAYSTACK_PUBLIC_KEY) {
      disabledFeatures.push({
         dependency: 'Paystack Public Key',
         impact:
            'Client-side payment initializations requiring the public key may be impaired.',
      });
   }

   // Emit a single structured warning using Pino if there are any disabled features
   if (disabledFeatures.length > 0) {
      logger.warn(
         { disabledDependencies: disabledFeatures },
         'Server starting with optional dependencies disabled. Some features will have limited functionality.'
      );
   }
}
