import dotenv from 'dotenv';

export { envSchema } from './config.schema';
import { envSchema } from './config.schema';

dotenv.config();

export const envConfig = envSchema.parse(process.env);

export const appConfig = {
   allowedOrigins: [
      'http://localhost:5173',
      'http://localhost:3000',
      envConfig.FRONTEND_URL,
   ].filter(Boolean),
};


