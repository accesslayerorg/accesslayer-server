// src/modules/status/status.types.ts
// Type definitions for platform status health check API and incident log (#1015).

export type ServiceStatus = 'operational' | 'degraded' | 'down';

export const CORE_SERVICES = [
   'database',
   'redis',
   'horizon',
   'soroban-rpc',
   'indexer',
] as const;

export type CoreServiceName = (typeof CORE_SERVICES)[number];

export interface ServiceHealthStatus {
   name: string;
   status: ServiceStatus;
   lastChecked: string;
   lastCheckedAt: string;
   latencyMs?: number;
   message?: string;
   error?: string;
}

export interface StatusResponse {
   success: boolean;
   status: ServiceStatus;
   timestamp: string;
   services: ServiceHealthStatus[];
}

export interface ServiceUptimeHistory {
   name: string;
   service: string;
   uptimePercentage: number;
   uptime: number;
   totalChecks: number;
   successfulChecks: number;
}

export interface StatusHistoryResponse {
   success: boolean;
   windowDays: number;
   range: {
      from: string;
      to: string;
   };
   services: ServiceUptimeHistory[];
   uptime: Record<string, number>;
}

export type IncidentStatus =
   | 'investigating'
   | 'identified'
   | 'monitoring'
   | 'resolved'
   | 'open';

export type IncidentImpact = 'none' | 'minor' | 'major' | 'critical';

export interface Incident {
   id: string;
   title: string;
   services: string[];
   status: IncidentStatus | string;
   impact: IncidentImpact | string;
   start: string;
   startedAt: string;
   resolution: string | null;
   resolvedAt: string | null;
   createdBy?: string | null;
   createdAt: string;
   updatedAt: string;
}

export interface CreateIncidentInput {
   title: string;
   services: string[];
   status?: IncidentStatus | string;
   impact?: IncidentImpact | string;
   start?: string;
   startedAt?: string;
   resolution?: string | null;
   resolvedAt?: string | null;
}

export interface ProbeRecord {
   service: string;
   status: ServiceStatus;
   latencyMs?: number;
   error?: string;
   timestamp: Date;
}
