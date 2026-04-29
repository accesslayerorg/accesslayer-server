import dotenv from 'dotenv';
import { envSchema } from './config.schema';

export { envSchema };

// Load environment variables from .env file
// Note: Does not override existing environment variables
dotenv.config();

/**
 * Validated and typed environment configuration.
 *
 * This object is immutable and available for import throughout the application.
 * Configuration values are resolved at startup and do not change at runtime.
 *
 * @example
 * import { envConfig } from './config';
 *
 * const port = envConfig.PORT;
 * const isProduction = envConfig.MODE === 'production';
 */
export const envConfig = envSchema.parse(process.env);

/**
 * Derived application configuration.
 * 
 * These values are computed from envConfig at startup.
 */
export const appConfig = {
   allowedOrigins: [
      'http://localhost:5173',
      'http://localhost:3000',
      envConfig.FRONTEND_URL,
   ].filter(Boolean),
};
