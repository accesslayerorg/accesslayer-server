import { prisma } from '../../utils/prisma.utils';

export interface GuardiansSetEvent {
   walletAddress: string;
   guardians: string[];
   threshold: number;
   delayLedgers?: number;
}

export interface RecoveryInitiatedEvent {
   requestId: string;
   walletAddress: string;
   initiator: string;
   newOwner: string;
   initiatedLedger: number;
   earliestExecute: number;
}

const RECOVERY_NOTIFICATION_CHANNELS = ['email', 'push', 'in_app'] as const;

export async function handleGuardiansSet(event: GuardiansSetEvent) {
   if (!event.walletAddress || !Array.isArray(event.guardians)) return;
   const threshold = Math.max(
      1,
      Math.min(event.threshold, event.guardians.length),
   );
   await prisma.guardianSet.upsert({
      where: { walletAddress: event.walletAddress },
      create: {
         walletAddress: event.walletAddress,
         guardians: event.guardians,
         threshold,
         delayLedgers: event.delayLedgers ?? 0,
      },
      update: {
         guardians: event.guardians,
         threshold,
         delayLedgers: event.delayLedgers ?? 0,
      },
   });
}

export async function handleRecoveryInitiated(event: RecoveryInitiatedEvent) {
   // Idempotent on requestId: replays do not duplicate rows or notifications.
   const existing = await prisma.recoveryRequest.findUnique({
      where: { id: event.requestId },
   });
   if (existing) return existing;

   const request = await prisma.recoveryRequest.create({
      data: {
         id: event.requestId,
         walletAddress: event.walletAddress,
         initiator: event.initiator,
         newOwner: event.newOwner,
         initiatedLedger: event.initiatedLedger,
         earliestExecute: event.earliestExecute,
         status: 'pending',
      },
   });

   // One high-priority notification record per enabled channel; the delivery
   // worker picks these up and writes deliveredAt once sent, so replays here
   // must not create duplicates — hence the upsert-by-id guard above.
   for (const channel of RECOVERY_NOTIFICATION_CHANNELS) {
      await prisma.recoveryNotification.create({
         data: {
            id: `${event.requestId}:${channel}`,
            walletAddress: event.walletAddress,
            requestId: event.requestId,
            priority: 'high',
            channel,
         },
      });
   }

   return request;
}

export async function handleRecoveryApproved(event: {
   requestId: string;
   guardian: string;
}) {
   await prisma.recoveryApproval.upsert({
      where: {
         requestId_guardian: {
            requestId: event.requestId,
            guardian: event.guardian,
         },
      },
      create: { requestId: event.requestId, guardian: event.guardian },
      update: {},
   });
}

export async function handleRecoveryCancelled(event: { requestId: string }) {
   const existing = await prisma.recoveryRequest.findUnique({
      where: { id: event.requestId },
   });
   if (!existing || existing.status !== 'pending') return;
   await prisma.recoveryRequest.update({
      where: { id: event.requestId },
      data: { status: 'cancelled', cancelledAt: new Date() },
   });
}

export async function handleRecoveryExecuted(event: { requestId: string }) {
   const existing = await prisma.recoveryRequest.findUnique({
      where: { id: event.requestId },
   });
   if (!existing || existing.status !== 'pending') return;
   await prisma.recoveryRequest.update({
      where: { id: event.requestId },
      data: { status: 'executed', executedAt: new Date() },
   });
}

export async function getRecoveryStatus(walletAddress: string, viewer?: string) {
   const [guardianSet, pending] = await Promise.all([
      prisma.guardianSet.findUnique({ where: { walletAddress } }),
      prisma.recoveryRequest.findFirst({
         where: { walletAddress, status: 'pending' },
         orderBy: { createdAt: 'desc' },
         include: { approvals: true },
      }),
   ]);

   if (!guardianSet) {
      return {
         walletAddress,
         hasGuardians: false,
         threshold: null,
         guardianCount: 0,
         guardians: [] as string[],
         canSeeDetails: false,
         pending: null,
      };
   }

   const isOwner = viewer === walletAddress;
   const isGuardian = viewer ? guardianSet.guardians.includes(viewer) : false;
   const canSeeDetails = isOwner || isGuardian;

   return {
      walletAddress,
      hasGuardians: true,
      threshold: guardianSet.threshold,
      guardianCount: guardianSet.guardians.length,
      guardians: canSeeDetails ? guardianSet.guardians : [],
      canSeeDetails,
      pending: pending
         ? {
              requestId: pending.id,
              initiator: pending.initiator,
              newOwner: pending.newOwner,
              initiatedLedger: pending.initiatedLedger,
              earliestExecute: pending.earliestExecute,
              approvals: pending.approvals.length,
              threshold: guardianSet.threshold,
              approvedBy: canSeeDetails
                 ? pending.approvals.map((a: { guardian: string }) => a.guardian)
                 : undefined,
           }
         : null,
   };
}

export async function getGuardianRequests(guardianAddress: string) {
   const sets = await prisma.guardianSet.findMany({
      where: { guardians: { has: guardianAddress } },
      select: { walletAddress: true, threshold: true },
   });
   const wallets = sets.map((s: { walletAddress: string }) => s.walletAddress);
   if (!wallets.length) return [];

   const requests = await prisma.recoveryRequest.findMany({
      where: { walletAddress: { in: wallets }, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      include: { approvals: true },
   });
   const thresholdByWallet = new Map(
      sets.map((s: { walletAddress: string; threshold: number }) => [
         s.walletAddress,
         s.threshold,
      ]),
   );
   return requests.map((r: {
      id: string;
      walletAddress: string;
      initiator: string;
      newOwner: string;
      initiatedLedger: number;
      earliestExecute: number;
      approvals: { guardian: string }[];
   }) => ({
      requestId: r.id,
      walletAddress: r.walletAddress,
      initiator: r.initiator,
      newOwner: r.newOwner,
      initiatedLedger: r.initiatedLedger,
      earliestExecute: r.earliestExecute,
      approvals: r.approvals.length,
      threshold: thresholdByWallet.get(r.walletAddress) ?? null,
      approvedByViewer: r.approvals.some((a) => a.guardian === guardianAddress),
   }));
}
