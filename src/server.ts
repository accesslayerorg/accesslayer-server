import app from './app';

import { envConfig } from './config';
import { logger } from './utils/logger.utils';
import { prisma } from './utils/prisma.utils';
import dotenv from 'dotenv'


dotenv.config()


async function startServer() {
   try {
      await prisma.$connect();
      logger.info('Connected to database');

      app.listen(envConfig.PORT, () => {
         logger.info(`Server running on port ${envConfig.PORT}`);
      });
   } catch (error) {
      console.error('Failed to start server:', error);
      await prisma.$disconnect();
      process.exit(1);
   }
}

// Handle uncaught exceptions
process.on('uncaughtException', error => {
   console.error('Uncaught Exception:', error);
   process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
   console.error('Unhandled Rejection at:', promise, 'reason:', reason);
   process.exit(1);
});

process.on('SIGINT', async () => {
   await prisma.$disconnect();
   console.log('💾 Database connection closed');

   console.log('👋 Shutdown complete');
   process.exit(0);
});

startServer();
