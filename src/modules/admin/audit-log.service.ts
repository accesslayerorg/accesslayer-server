import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';

export interface CreateAuditEntryInput {
   actorWallet: string;
   actionType: string;
   targetId?: string;
   payload?: Record<string, unknown>;
}

/**
 * Creates an audit log entry for an admin action.
 * This is specifically for queryable admin action tracking.
 */
export async function createAuditEntry(
   input: CreateAuditEntryInput
): Promise<void> {
   try {
      await prisma.auditLog.create({
         data: {
            actorWallet: input.actorWallet,
            actionType: input.actionType,
            targetId: input.targetId,
            payload: input.payload ? (input.payload as any) : undefined,
         },
      });
   } catch (error) {
      logger.error({ error, input }, 'Failed to create audit log entry');
      // Don't rethrow - audit logging failures shouldn't break admin operations
   }
}

export interface GetAuditLogsInput {
   limit?: number;
   cursor?: string; // id of last item from previous page
   actionType?: string;
   fromDate?: string | Date;
   toDate?: string | Date;
   from?: string | Date;
   to?: string | Date;
   startDate?: string | Date;
   endDate?: string | Date;
}

export interface AuditLogEntry {
   id: string;
   actorWallet: string;
   actionType: string;
   targetId: string | null;
   payload: Record<string, unknown> | null;
   createdAt: Date;
}

export interface GetAuditLogsResult {
   entries: AuditLogEntry[];
   nextCursor?: string;
   hasMore: boolean;
}

/**
 * Retrieves audit log entries with cursor-based pagination and optional filtering.
 * Returns entries sorted by createdAt descending.
 */
export async function getAuditLogs(
   input: GetAuditLogsInput
): Promise<GetAuditLogsResult> {
   const limit = Math.min(input.limit || 50, 100); // Max 100 per page
   const take = limit + 1; // Fetch one extra to detect hasMore

   try {
      const where: Record<string, unknown> = {};
      if (input.actionType) {
         where.actionType = input.actionType;
      }

      const start = input.fromDate || input.from || input.startDate;
      const end = input.toDate || input.to || input.endDate;

      if (start || end) {
         const createdAtFilter: Record<string, Date> = {};
         if (start) {
            createdAtFilter.gte = new Date(start);
         }
         if (end) {
            createdAtFilter.lte = new Date(end);
         }
         where.createdAt = createdAtFilter;
      }

      // Cursor-based pagination: fetch by createdAt and id
      const entries = await prisma.auditLog.findMany({
         where,
         orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
         take,
         skip: input.cursor ? 1 : 0, // Skip the cursor item itself
         cursor: input.cursor
            ? {
                 id: input.cursor,
              }
            : undefined,
      });

      const hasMore = entries.length > limit;
      const result = entries.slice(0, limit);
      const nextCursor = hasMore && result.length > 0 ? result[result.length - 1].id : undefined;

      return {
         entries: result as AuditLogEntry[],
         nextCursor,
         hasMore,
      };
   } catch (error) {
      logger.error({ error, input }, 'Failed to get audit logs');
      throw error;
   }
}
