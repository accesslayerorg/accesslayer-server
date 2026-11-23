export interface RetentionRule {
   tableName: string;
   timestampColumn: string;
   maxAgeDays: number;
   statusColumn?: string;
   eligibleStatuses?: readonly string[];
}

/**
 * Persisted short-lived records owned by this service. Redis cache and
 * consumed-nonce keys already use Redis TTLs; the worker separately prunes
 * expired in-process nonce guards.
 */
export const RETENTION_RULES: readonly RetentionRule[] = [
   {
      tableName: 'session_activity',
      timestampColumn: 'timestamp',
      maxAgeDays: 30,
   },
   {
      tableName: 'security_flags',
      timestampColumn: 'createdAt',
      maxAgeDays: 30,
   },
   {
      tableName: 'WebhookEvent',
      timestampColumn: 'createdAt',
      maxAgeDays: 30,
      statusColumn: 'status',
      eligibleStatuses: ['DELIVERED', 'FAILED'],
   },
   {
      tableName: 'OutboxEvent',
      timestampColumn: 'publishedAt',
      maxAgeDays: 30,
   },
   {
      tableName: 'retention_runs',
      timestampColumn: 'createdAt',
      maxAgeDays: 90,
   },
];
