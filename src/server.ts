/// <reference types="node" />
import app from './app';

import { envConfig } from './config';
import { logger } from './utils/logger.utils';
import { prisma } from './utils/prisma.utils';
import { verifyMigrationChecksums } from './utils/migration-checksum.utils';
import {
   IndexerFlagsConfigError,
   runIndexerFeatureFlagsStartupCheck,
} from './utils/indexer-flags-startup-check.utils';
import { checkOptionalDependencies } from './utils/startup.utils';
import { describeDatabasePoolConfig } from './utils/db-pool-config.utils';
import { stopOwnershipSnapshotCleanupJob } from './jobs/ownership-snapshot-cleanup.job';
import {
   startDetectPriceMovementsJob,
   stopDetectPriceMovementsJob,
} from './jobs/detect-price-movements.job';
import {
   startGovernanceSyncJob,
   stopGovernanceSyncJob,
} from './jobs/governance-sync.job';
import { connectRedis, disconnectRedis } from './utils/redis.utils';
import {
   broadcastServerClosing,
   closeAllConnections,
} from './utils/sse-fanout.utils';
import { buildStartupConfigSummary } from './utils/config-summary.utils';
import {
   startSorobanWALRecoveryJob,
   stopSorobanWALRecoveryJob,
} from './jobs/soroban-wal-recovery.job';

async function startServer() {
   try {
      // Validate indexer feature flags before any code paths read them. We
      // fail fast here so operators see every misconfiguration at once
      // instead of cryptic runtime errors later in the boot sequence.
      try {
         runIndexerFeatureFlagsStartupCheck();
      } catch (err) {
         if (err instanceof IndexerFlagsConfigError) {
            logger.error(
               { issues: err.issues },
               'Refusing to start: indexer feature flags are misconfigured'
            );
            process.exit(1);
         }
         throw err;
      }

      await prisma.$connect();
      logger.info('Connected to database');

      await connectRedis();
      logger.info('Connected to Redis');

      // Surface connection-pool settings (no credentials) so connection
      // exhaustion is diagnosable. Logged before the server accepts requests.
      logger.info(
         describeDatabasePoolConfig(),
         'Database connection pool configured'
      );

      // Emit a structured summary of the loaded runtime config: environment
      // context and key feature flags. Values flow through the masking helper,
      // so no secrets or credentials are logged. See
      // utils/config-summary.utils.ts for the curated field selection.
      logger.info(
         buildStartupConfigSummary(),
         'Loaded runtime configuration summary'
      );

      // Verify migrations on startup
      await verifyMigrationChecksums();

      // Check and warn about disabled optional dependencies (non-blocking)
      checkOptionalDependencies();

      startDetectPriceMovementsJob();
      startGovernanceSyncJob();
      startSorobanWALRecoveryJob();

      const server = app.listen(envConfig.PORT, () => {
         logger.info(`Server running on port ${envConfig.PORT}`);
      });

      return server;
   } catch (error) {
      logger.error({ error }, 'Failed to start server');
      await prisma.$disconnect();
      await disconnectRedis().catch(() => {});
      process.exit(1);
   }
}

// Handle uncaught exceptions
process.on('uncaughtException', error => {
   logger.fatal({ error }, 'Uncaught exception');
   process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
   logger.fatal({ reason, promise }, 'Unhandled promise rejection');
   process.exit(1);
});

function createGracefulShutdownHandler(server: ReturnType<typeof app.listen>) {
   return async () => {
      logger.info('Shutting down SSE connections');
      broadcastServerClosing();
      await new Promise(resolve => setTimeout(resolve, 1000));
      closeAllConnections();

      stopOwnershipSnapshotCleanupJob();
      stopDetectPriceMovementsJob();
      stopGovernanceSyncJob();
      stopSorobanWALRecoveryJob();
      await prisma.$disconnect();
      logger.info('Database connection closed');

      await disconnectRedis().catch(() => {});
      logger.info('Redis connection closed');

      const DRAIN_WINDOW_MS = 5000;
      const SHUTDOWN_TIMEOUT_MS = 30000;

      app.use((_req, res, _next) => {
         res.status(503).json({ error: 'Server is shutting down' });
      });

      const shutdownTimer = setTimeout(() => {
         logger.error('Shutdown timeout reached, forcing exit');
         process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);

      server.close(async () => {
         clearTimeout(shutdownTimer);
         logger.info('HTTP server closed, draining requests');

         await new Promise(resolve => setTimeout(resolve, DRAIN_WINDOW_MS));

         await prisma.$disconnect();
         logger.info('Database connection closed');

         await disconnectRedis().catch(() => {});
         logger.info('Redis connection closed');

         logger.info('Shutdown complete');
         process.exit(0);
      });
   };
}

startServer().then(server => {
   const shutdownHandler = createGracefulShutdownHandler(server);
   process.on('SIGINT', shutdownHandler);
   process.on('SIGTERM', shutdownHandler);
});
