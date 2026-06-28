import {
   getMissingRequiredEnvVars,
   MissingRequiredEnvError,
   REQUIRED_ENV_VARS,
   validateRequiredEnvVars,
} from './config.required';

const COMPLETE_REQUIRED_ENV: Record<string, string | undefined> =
   Object.fromEntries(
      REQUIRED_ENV_VARS.map(name => [name, `${name.toLowerCase()}-value`])
   );

describe('Required environment startup validation', () => {
   it('lists required variables in one central location', () => {
      expect(REQUIRED_ENV_VARS).toEqual([
         'DATABASE_URL',
         'GMAIL_USER',
         'GMAIL_APP_PASSWORD',
         'GOOGLE_CLIENT_ID',
         'GOOGLE_CLIENT_SECRET',
         'BACKEND_URL',
         'FRONTEND_URL',
         'CLOUDINARY_CLOUD_NAME',
         'CLOUDINARY_API_KEY',
         'CLOUDINARY_API_SECRET',
         'PAYSTACK_SECRET_KEY',
      ]);
   });

   it('does not include optional variables in the required startup check', () => {
      expect(REQUIRED_ENV_VARS).not.toContain('PAYSTACK_PUBLIC_KEY');
      expect(REQUIRED_ENV_VARS).not.toContain('PORT');
      expect(REQUIRED_ENV_VARS).not.toContain('APP_SECRET');
   });

   it('detects absent and empty required variables', () => {
      const env = {
         ...COMPLETE_REQUIRED_ENV,
         DATABASE_URL: '',
         GOOGLE_CLIENT_ID: '   ',
         CLOUDINARY_API_SECRET: undefined,
      };

      expect(getMissingRequiredEnvVars(env)).toEqual([
         'DATABASE_URL',
         'GOOGLE_CLIENT_ID',
         'CLOUDINARY_API_SECRET',
      ]);
   });

   it('passes when every required variable is present and non-empty', () => {
      expect(() =>
         validateRequiredEnvVars(COMPLETE_REQUIRED_ENV)
      ).not.toThrow();
   });

   it('throws a descriptive error naming the missing variable', () => {
      expect(() =>
         validateRequiredEnvVars({
            ...COMPLETE_REQUIRED_ENV,
            DATABASE_URL: undefined,
         })
      ).toThrow(MissingRequiredEnvError);

      try {
         validateRequiredEnvVars({
            ...COMPLETE_REQUIRED_ENV,
            DATABASE_URL: undefined,
         });
      } catch (error) {
         expect(error).toBeInstanceOf(MissingRequiredEnvError);
         expect((error as MissingRequiredEnvError).missingVariables).toEqual([
            'DATABASE_URL',
         ]);
         expect((error as Error).message).toContain('DATABASE_URL');
      }
   });
});
