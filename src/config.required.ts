export const REQUIRED_ENV_VARS = [
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
] as const;

export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

export class MissingRequiredEnvError extends Error {
   readonly missingVariables: RequiredEnvVar[];

   constructor(missingVariables: RequiredEnvVar[]) {
      const variableLabel =
         missingVariables.length === 1
            ? 'environment variable'
            : 'environment variables';

      super(
         `Missing required ${variableLabel}: ${missingVariables.join(', ')}`
      );
      this.name = 'MissingRequiredEnvError';
      this.missingVariables = missingVariables;
   }
}

export function getMissingRequiredEnvVars(
   env: Record<string, string | undefined>
): RequiredEnvVar[] {
   return REQUIRED_ENV_VARS.filter(name => {
      const value = env[name];
      return value === undefined || value.trim().length === 0;
   });
}

export function validateRequiredEnvVars(
   env: Record<string, string | undefined>
): void {
   const missingVariables = getMissingRequiredEnvVars(env);

   if (missingVariables.length > 0) {
      throw new MissingRequiredEnvError(missingVariables);
   }
}
