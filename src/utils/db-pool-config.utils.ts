import { envConfig } from '../config';

/**
 * Connection-pool settings safe to log at startup.
 *
 * Prisma reads pool settings from the `DATABASE_URL` query string
 * (`connection_limit`, `pool_timeout`, `connect_timeout`). When a value is not
 * present in the URL, Prisma applies its own default, reported here as
 * `'default'`. No host, credentials, or other connection-string details are
 * included so this object is safe to emit to logs.
 */
export interface DatabasePoolConfig {
   /** Max connections in the pool (`connection_limit`); Prisma default ≈ num_cpus * 2 + 1. */
   poolSize: number | 'default';
   /** Seconds to wait for a free connection before timing out (`pool_timeout`). */
   poolTimeoutSeconds: number | 'default';
   /** Seconds to wait when opening a new connection (`connect_timeout`). */
   connectTimeoutSeconds: number | 'default';
   /** Per-query timeout enforced by the Prisma client extension. */
   queryTimeoutMs: number;
}

function readNumericParam(
   params: URLSearchParams | undefined,
   key: string
): number | 'default' {
   const raw = params?.get(key);
   if (raw == null || raw === '') {
      return 'default';
   }
   const value = Number(raw);
   return Number.isFinite(value) ? value : 'default';
}

/**
 * Extracts the loggable connection-pool configuration from the database URL.
 * Parsing failures degrade gracefully to all-default values rather than
 * throwing during startup.
 */
export function describeDatabasePoolConfig(
   databaseUrl: string = envConfig.DATABASE_URL,
   queryTimeoutMs: number = envConfig.DB_QUERY_TIMEOUT_MS
): DatabasePoolConfig {
   let params: URLSearchParams | undefined;
   try {
      params = new URL(databaseUrl).searchParams;
   } catch {
      params = undefined;
   }

   return {
      poolSize: readNumericParam(params, 'connection_limit'),
      poolTimeoutSeconds: readNumericParam(params, 'pool_timeout'),
      connectTimeoutSeconds: readNumericParam(params, 'connect_timeout'),
      queryTimeoutMs,
   };
}
