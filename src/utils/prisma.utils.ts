import { PrismaClient } from '@prisma/client';
import { envConfig } from '../config';
import { requestContextStorage } from './als.utils';
import { logger } from './logger.utils';

// Use global variable to prevent multiple instances in development
declare global {
   var prisma: any | undefined;
}

const basePrisma = new PrismaClient({
   log:
      envConfig.MODE === 'development'
         ? ['query', 'error', 'warn']
         : ['error'],
   datasourceUrl: envConfig.DATABASE_URL,
});

// Extend Prisma with query timeout
export const prisma = basePrisma.$extends({
   query: {
      $allOperations({ operation, model, args, query }) {
         const timeoutMs = envConfig.DB_QUERY_TIMEOUT_MS;
         const context = requestContextStorage.getStore();

         let timeoutId: NodeJS.Timeout;
         const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
               const logContext = {
                  type: 'database_timeout',
                  operation,
                  model,
                  timeoutMs,
                  path: context?.path,
                  method: context?.method,
                  requestId: context?.requestId,
               };
               logger.error(logContext, `Database query timed out after ${timeoutMs}ms`);
               reject(new Error(`Database query timed out after ${timeoutMs}ms`));
            }, timeoutMs);
         });

         return Promise.race([
            query(args).finally(() => clearTimeout(timeoutId)),
            timeoutPromise,
         ]);
      },
   },
});

// Prevent multiple instances in development environment
if (envConfig.MODE !== 'production') {
   global.prisma = prisma;
}
