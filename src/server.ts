/// <reference types="node" />
import app from './app';

import { envConfig } from './config';
import { logger } from './utils/logger.utils';
import { prisma } from './utils/prisma.utils';
import { verifyMigrationChecksums } from './utils/migration-checksum.utils';
import {
   startOwnershipSnapshotCleanupJob,
   stopOwnershipSnapshotCleanupJob,
} from './jobs/ownership-snapshot-cleanup.job';


async function startServer() {
   try {
      await prisma.$connect();
      logger.info('Connected to database');

      // Verify migrations on startup
      await verifyMigrationChecksums();

      startOwnershipSnapshotCleanupJob();

      app.listen(envConfig.PORT, () => {
         logger.info(`Server running on port ${envConfig.PORT}`);
      });

      return server;
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
   stopOwnershipSnapshotCleanupJob();
   await prisma.$disconnect();
   console.log('💾 Database connection closed');

      const DRAIN_WINDOW_MS = 5000;
      const SHUTDOWN_TIMEOUT_MS = 30000;

      app.use((_req, res, _next) => {
         res.status(503).json({ error: 'Server is shutting down' });
      });

      const shutdownTimer = setTimeout(() => {
         console.error('❌ Shutdown timeout reached, forcing exit');
         process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);

      server.close(async () => {
         clearTimeout(shutdownTimer);
         console.log('✅ HTTP server closed, draining requests');

         await new Promise((resolve) => setTimeout(resolve, DRAIN_WINDOW_MS));

         await prisma.$disconnect();
         console.log('💾 Database connection closed');

         console.log('👋 Shutdown complete');
         process.exit(0);
      });
   };
}

startServer().then((server) => {
   const shutdownHandler = createGracefulShutdownHandler(server);
   process.on('SIGINT', shutdownHandler);
   process.on('SIGTERM', shutdownHandler);
});
