import { prisma } from './prisma.utils';

export interface AuditEventPayload {
  actor: string;
  action: string;
  target: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

export async function emitAuditEvent(payload: AuditEventPayload): Promise<void> {
  try {
    const data: Record<string, unknown> = {
      actor: payload.actor,
      action: payload.action,
      target: payload.target,
      targetId: payload.targetId,
    };

    if (payload.metadata) {
      data.metadata = payload.metadata as Record<string, unknown>;
    }

    await prisma.auditEvent.create({
      data: data as Parameters<typeof prisma.auditEvent.create>[0]['data'],
    });
  } catch (error) {
    console.error('Failed to emit audit event:', error);
  }
}
