// src/modules/status/status.service.ts
// Platform status health check, probe execution, uptime, and incident logging (#1015).

import { randomUUID } from 'crypto';
import { envConfig } from '../../config';
import { prisma } from '../../utils/prisma.utils';
import { getRedisClient } from '../../utils/redis.utils';
import { horizonGet } from '../../clients/horizon.client';
import { indexerHeartbeat } from '../../utils/heartbeat.service';
import { logger } from '../../utils/logger.utils';
import { buildPaginationMeta } from '../../utils/pagination.utils';
import {
   CORE_SERVICES,
   CreateIncidentInput,
   Incident,
   ProbeRecord,
   ServiceHealthStatus,
   ServiceStatus,
   ServiceUptimeHistory,
   StatusHistoryResponse,
   StatusResponse,
} from './status.types';

/** Stale probe threshold: 3 minutes (3x the 60-second probe interval). */
const STALE_PROBE_THRESHOLD_MS = 180_000;

/** In-memory store for fast responses and graceful fallback. */
interface InMemoryStatusStore {
   latestProbes: Map<string, ServiceHealthStatus>;
   probeHistory: ProbeRecord[];
   incidents: Incident[];
}

const statusStore: InMemoryStatusStore = {
   latestProbes: new Map<string, ServiceHealthStatus>(),
   probeHistory: [],
   incidents: [],
};

// -----------------------------------------------------------------------------
// Probes for Core Dependencies
// -----------------------------------------------------------------------------

export async function probeDatabase(timeoutMs = 5000): Promise<ServiceHealthStatus> {
   const start = Date.now();
   const nowIso = new Date().toISOString();

   try {
      await Promise.race([
         prisma.$queryRaw`SELECT 1`,
         new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Database probe timed out')), timeoutMs)
         ),
      ]);

      const latencyMs = Date.now() - start;
      return {
         name: 'database',
         status: 'operational',
         lastChecked: nowIso,
         lastCheckedAt: nowIso,
         latencyMs,
         message: 'Database connection healthy',
      };
   } catch (error) {
      const latencyMs = Date.now() - start;
      const errorMsg = error instanceof Error ? error.message : 'Database error';
      logger.warn({ error, latencyMs }, 'Database health probe failed');

      return {
         name: 'database',
         status: 'down',
         lastChecked: nowIso,
         lastCheckedAt: nowIso,
         latencyMs,
         error: errorMsg,
         message: 'Database unavailable or disconnected',
      };
   }
}

export async function probeRedis(timeoutMs = 3000): Promise<ServiceHealthStatus> {
   const start = Date.now();
   const nowIso = new Date().toISOString();

   try {
      const client = getRedisClient();
      if (!client) {
         const status: ServiceStatus = envConfig.ENABLE_REDIS_CACHE ? 'degraded' : 'operational';
         return {
            name: 'redis',
            status,
            lastChecked: nowIso,
            lastCheckedAt: nowIso,
            latencyMs: 0,
            message: envConfig.ENABLE_REDIS_CACHE
               ? 'Redis client not initialized'
               : 'Redis cache disabled by configuration',
         };
      }

      const pong = await Promise.race([
         client.ping(),
         new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Redis ping timed out')), timeoutMs)
         ),
      ]);

      const latencyMs = Date.now() - start;
      if (pong === 'PONG') {
         return {
            name: 'redis',
            status: 'operational',
            lastChecked: nowIso,
            lastCheckedAt: nowIso,
            latencyMs,
            message: 'Redis connection healthy',
         };
      }

      return {
         name: 'redis',
         status: 'degraded',
         lastChecked: nowIso,
         lastCheckedAt: nowIso,
         latencyMs,
         error: `Unexpected PING response: ${pong}`,
         message: 'Redis degraded response',
      };
   } catch (error) {
      const latencyMs = Date.now() - start;
      const errorMsg = error instanceof Error ? error.message : 'Redis error';
      logger.warn({ error, latencyMs }, 'Redis health probe failed');

      return {
         name: 'redis',
         status: 'down',
         lastChecked: nowIso,
         lastCheckedAt: nowIso,
         latencyMs,
         error: errorMsg,
         message: 'Redis unavailable or disconnected',
      };
   }
}

export async function probeHorizon(timeoutMs = 4000): Promise<ServiceHealthStatus> {
   const start = Date.now();
   const nowIso = new Date().toISOString();

   try {
      const response = await horizonGet('/', { timeoutMs });
      const latencyMs = Date.now() - start;

      if (response.ok) {
         return {
            name: 'horizon',
            status: 'operational',
            lastChecked: nowIso,
            lastCheckedAt: nowIso,
            latencyMs,
            message: 'Stellar Horizon API operational',
         };
      }

      const status: ServiceStatus = response.status >= 500 ? 'down' : 'degraded';
      return {
         name: 'horizon',
         status,
         lastChecked: nowIso,
         lastCheckedAt: nowIso,
         latencyMs,
         error: `Horizon returned HTTP ${response.status}`,
         message: `Horizon returned HTTP ${response.status}`,
      };
   } catch (error) {
      const latencyMs = Date.now() - start;
      const errorMsg = error instanceof Error ? error.message : 'Horizon request failed';
      logger.warn({ error, latencyMs }, 'Horizon health probe failed');

      return {
         name: 'horizon',
         status: 'down',
         lastChecked: nowIso,
         lastCheckedAt: nowIso,
         latencyMs,
         error: errorMsg,
         message: 'Stellar Horizon API unreachable',
      };
   }
}

export async function probeSorobanRpc(timeoutMs = 4000): Promise<ServiceHealthStatus> {
   const start = Date.now();
   const nowIso = new Date().toISOString();
   const url = envConfig.STELLAR_SOROBAN_RPC_URL;

   if (!url) {
      return {
         name: 'soroban-rpc',
         status: 'degraded',
         lastChecked: nowIso,
         lastCheckedAt: nowIso,
         message: 'Soroban RPC URL not configured',
      };
   }

   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(), timeoutMs);

   try {
      const response = await fetch(url, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
         signal: controller.signal,
      });

      const latencyMs = Date.now() - start;

      if (response.ok) {
         const body = (await response.json()) as {
            result?: { status?: string };
            error?: unknown;
         };
         const isHealthy =
            body?.result?.status === 'healthy' ||
            (!body?.error && typeof body?.result !== 'undefined');

         return {
            name: 'soroban-rpc',
            status: isHealthy ? 'operational' : 'degraded',
            lastChecked: nowIso,
            lastCheckedAt: nowIso,
            latencyMs,
            message: isHealthy ? 'Soroban RPC operational' : 'Soroban RPC degraded',
         };
      }

      const status: ServiceStatus = response.status >= 500 ? 'down' : 'degraded';
      return {
         name: 'soroban-rpc',
         status,
         lastChecked: nowIso,
         lastCheckedAt: nowIso,
         latencyMs,
         error: `Soroban RPC HTTP ${response.status}`,
         message: `Soroban RPC HTTP ${response.status}`,
      };
   } catch (error) {
      const latencyMs = Date.now() - start;
      const errorMsg = error instanceof Error ? error.message : 'Soroban RPC request failed';
      logger.warn({ error, latencyMs }, 'Soroban RPC health probe failed');

      return {
         name: 'soroban-rpc',
         status: 'down',
         lastChecked: nowIso,
         lastCheckedAt: nowIso,
         latencyMs,
         error: errorMsg,
         message: 'Soroban RPC unreachable',
      };
   } finally {
      clearTimeout(timer);
   }
}

export function probeIndexer(): ServiceHealthStatus {
   const nowIso = new Date().toISOString();
   const heartbeatState = indexerHeartbeat.getStatus();

   let status: ServiceStatus = 'operational';
   let message = 'Indexer worker operational';

   if (heartbeatState.status === 'degraded') {
      status = 'degraded';
      message = 'Indexer heartbeat is stale';
   } else if (heartbeatState.status === 'unknown') {
      status = 'operational';
      message = 'Indexer status unknown (no heartbeat recorded yet)';
   } else if (heartbeatState.status === 'healthy') {
      status = 'operational';
      message = 'Indexer worker operational';
   }

   return {
      name: 'indexer',
      status,
      lastChecked: nowIso,
      lastCheckedAt: nowIso,
      message,
   };
}

// -----------------------------------------------------------------------------
// Probes Runner & Storage
// -----------------------------------------------------------------------------

export async function runAllProbes(): Promise<ServiceHealthStatus[]> {
   const results = await Promise.all([
      probeDatabase(),
      probeRedis(),
      probeHorizon(),
      probeSorobanRpc(),
      Promise.resolve(probeIndexer()),
   ]);

   const now = new Date();

   // Update in-memory state
   for (const probe of results) {
      statusStore.latestProbes.set(probe.name, probe);
      statusStore.probeHistory.push({
         service: probe.name,
         status: probe.status,
         latencyMs: probe.latencyMs,
         error: probe.error,
         timestamp: now,
      });
   }

   // Keep last 45,000 records in memory (~30 days at 1 sample/min * 5 services = ~216k max)
   const MAX_HISTORY = 50_000;
   if (statusStore.probeHistory.length > MAX_HISTORY) {
      statusStore.probeHistory = statusStore.probeHistory.slice(-MAX_HISTORY);
   }

   // Best-effort persistence to database
   void (async () => {
      try {
         const dbProbeModel = (prisma as any).platformStatusProbe;
         if (dbProbeModel?.createMany) {
            await dbProbeModel.createMany({
               data: results.map(r => ({
                  service: r.name,
                  status: r.status,
                  latencyMs: r.latencyMs ?? null,
                  error: r.error ?? null,
                  createdAt: now,
               })),
            });
         }
      } catch (err) {
         // Non-blocking: status probe logging must never crash the service
         logger.debug({ err }, 'Failed to persist probe results to database');
      }
   })();

   return results;
}

// -----------------------------------------------------------------------------
// GET /status
// -----------------------------------------------------------------------------

export async function getLatestStatus(): Promise<StatusResponse> {
   const now = Date.now();
   const nowIso = new Date(now).toISOString();

   // If no probes have run yet, kick off probes in background without blocking response
   if (statusStore.latestProbes.size === 0) {
      void runAllProbes();
   }

   const services: ServiceHealthStatus[] = [];

   for (const serviceName of CORE_SERVICES) {
      const cached = statusStore.latestProbes.get(serviceName);

      if (!cached) {
         services.push({
            name: serviceName,
            status: 'operational',
            lastChecked: nowIso,
            lastCheckedAt: nowIso,
            message: 'Initializing probe',
         });
         continue;
      }

      // Check staleness: if last check was > STALE_PROBE_THRESHOLD_MS ago, mark degraded
      const lastCheckTime = new Date(cached.lastChecked).getTime();
      const isStale = now - lastCheckTime > STALE_PROBE_THRESHOLD_MS;

      if (isStale) {
         services.push({
            ...cached,
            status: 'degraded',
            message: `Probe result is stale (last checked ${Math.round(
               (now - lastCheckTime) / 1000
            )}s ago)`,
         });
      } else {
         services.push(cached);
      }
   }

   // Compute overall status
   let overallStatus: ServiceStatus = 'operational';
   if (services.some(s => s.status === 'down')) {
      overallStatus = 'down';
   } else if (services.some(s => s.status === 'degraded')) {
      overallStatus = 'degraded';
   }

   return {
      success: true,
      status: overallStatus,
      timestamp: nowIso,
      services,
   };
}

// -----------------------------------------------------------------------------
// GET /status/history (30-day uptime)
// -----------------------------------------------------------------------------

export async function get30DayUptimeHistory(
   windowDays = 30
): Promise<StatusHistoryResponse> {
   const now = new Date();
   const windowMs = windowDays * 24 * 60 * 60 * 1000;
   const windowStart = new Date(now.getTime() - windowMs);

   // Attempt to query database for aggregate history if available
   let dbRecords: Array<{ service: string; status: string }> | null = null;
   try {
      const dbProbeModel = (prisma as any).platformStatusProbe;
      if (dbProbeModel?.findMany) {
         const results = await dbProbeModel.findMany({
            where: { createdAt: { gte: windowStart } },
            select: { service: true, status: true },
         });
         if (Array.isArray(results) && results.length > 0) {
            dbRecords = results;
         }
      }
   } catch {
      // Fallback to in-memory store
   }

   const records =
      dbRecords ??
      statusStore.probeHistory.filter(p => p.timestamp >= windowStart);

   const services: ServiceUptimeHistory[] = [];
   const uptimeMap: Record<string, number> = {};

   for (const serviceName of CORE_SERVICES) {
      const serviceRecords = records.filter(
         r => r.service.toLowerCase() === serviceName.toLowerCase()
      );

      const totalChecks = serviceRecords.length;
      const successfulChecks = serviceRecords.filter(
         r => r.status === 'operational'
      ).length;

      let uptimePercentage = 100.0;
      if (totalChecks > 0) {
         uptimePercentage =
            Math.round((successfulChecks / totalChecks) * 10000) / 100;
      }

      const item: ServiceUptimeHistory = {
         name: serviceName,
         service: serviceName,
         uptimePercentage,
         uptime: uptimePercentage,
         totalChecks,
         successfulChecks,
      };

      services.push(item);
      uptimeMap[serviceName] = uptimePercentage;
   }

   return {
      success: true,
      windowDays,
      range: {
         from: windowStart.toISOString(),
         to: now.toISOString(),
      },
      services,
      uptime: uptimeMap,
   };
}

// -----------------------------------------------------------------------------
// Incidents (GET & POST)
// -----------------------------------------------------------------------------

export async function createIncident(
   input: CreateIncidentInput,
   adminWallet?: string
): Promise<Incident> {
   const now = new Date();
   const start = input.start || input.startedAt || now.toISOString();
   const resolvedAt = input.resolvedAt ?? null;
   const resolution = input.resolution ?? null;

   const incident: Incident = {
      id: 'inc_' + randomUUID(),
      title: input.title,
      services: input.services,
      status: input.status || 'investigating',
      impact: input.impact || 'minor',
      start,
      startedAt: start,
      resolution,
      resolvedAt,
      createdBy: adminWallet ?? null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
   };

   // Store in-memory
   statusStore.incidents.unshift(incident);

   // Persist to database if available
   try {
      const dbIncidentModel = (prisma as any).platformIncident;
      if (dbIncidentModel?.create) {
         await dbIncidentModel.create({
            data: {
               id: incident.id,
               title: incident.title,
               services: incident.services,
               status: incident.status,
               impact: incident.impact,
               startedAt: new Date(incident.startedAt),
               resolution: incident.resolution,
               resolvedAt: incident.resolvedAt ? new Date(incident.resolvedAt) : null,
               createdBy: incident.createdBy,
               createdAt: now,
               updatedAt: now,
            },
         });
      }
   } catch (err) {
      logger.debug({ err }, 'Failed to persist incident to database');
   }

   return incident;
}

export async function getIncidents(options: {
   page?: number;
   limit?: number;
   status?: string;
   service?: string;
}): Promise<{
   incidents: Incident[];
   pagination: ReturnType<typeof buildPaginationMeta>;
}> {
   const page = Math.max(1, options.page ?? 1);
   const limit = Math.max(1, options.limit ?? 20);

   // Try DB first
   try {
      const dbIncidentModel = (prisma as any).platformIncident;
      if (dbIncidentModel?.findMany && dbIncidentModel?.count) {
         const where: Record<string, unknown> = {};
         if (options.status && options.status !== 'all') {
            where.status = options.status;
         }
         if (options.service) {
            where.services = { has: options.service };
         }

         const [dbList, total] = await Promise.all([
            dbIncidentModel.findMany({
               where,
               skip: (page - 1) * limit,
               take: limit,
               orderBy: { startedAt: 'desc' },
            }),
            dbIncidentModel.count({ where }),
         ]);

         if (Array.isArray(dbList) && dbList.length > 0) {
            const incidents: Incident[] = dbList.map((row: any) => ({
               id: row.id,
               title: row.title,
               services: row.services,
               status: row.status,
               impact: row.impact,
               start: new Date(row.startedAt).toISOString(),
               startedAt: new Date(row.startedAt).toISOString(),
               resolution: row.resolution,
               resolvedAt: row.resolvedAt
                  ? new Date(row.resolvedAt).toISOString()
                  : null,
               createdBy: row.createdBy,
               createdAt: new Date(row.createdAt).toISOString(),
               updatedAt: new Date(row.updatedAt).toISOString(),
            }));

            return {
               incidents,
               pagination: buildPaginationMeta({ page, pageSize: limit, totalItems: total }),
            };
         }
      }
   } catch {
      // Fallback to in-memory store
   }

   // Filter in-memory
   let filtered = [...statusStore.incidents];

   if (options.status && options.status !== 'all') {
      filtered = filtered.filter(
         inc => inc.status.toLowerCase() === options.status!.toLowerCase()
      );
   }

   if (options.service) {
      filtered = filtered.filter(inc =>
         inc.services.some(s => s.toLowerCase() === options.service!.toLowerCase())
      );
   }

   // Sort descending by start time
   filtered.sort(
      (a, b) =>
         new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
   );

   const total = filtered.length;
   const startIndex = (page - 1) * limit;
   const pageItems = filtered.slice(startIndex, startIndex + limit);

   return {
      incidents: pageItems,
      pagination: buildPaginationMeta({ page, pageSize: limit, totalItems: total }),
   };
}

// -----------------------------------------------------------------------------
// Testing Helpers
// -----------------------------------------------------------------------------

export function resetStatusStore(): void {
   statusStore.latestProbes.clear();
   statusStore.probeHistory = [];
   statusStore.incidents = [];
}

export function recordProbeForTesting(
   service: string,
   status: ServiceStatus,
   timestamp: Date = new Date(),
   latencyMs = 10
): void {
   const nowIso = timestamp.toISOString();
   statusStore.latestProbes.set(service, {
      name: service,
      status,
      lastChecked: nowIso,
      lastCheckedAt: nowIso,
      latencyMs,
      message: `Test status: ${status}`,
   });
   statusStore.probeHistory.push({
      service,
      status,
      latencyMs,
      timestamp,
   });
}
