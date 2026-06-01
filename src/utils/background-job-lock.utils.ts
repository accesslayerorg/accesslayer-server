import { envConfig } from '../config';
import { logger } from './logger.utils';

interface LockEntry {
   owner: string;
   expiresAtMs: number;
}

const locks = new Map<string, LockEntry>();

export interface AcquireJobLockParams {
   name: string;
   owner: string;
   ttlMs?: number;
}

export interface AcquireJobLockResult {
   acquired: boolean;
   expiresAt?: string;
   holder?: string;
}

export function acquireJobLock({
   name,
   owner,
   ttlMs = envConfig.BACKGROUND_JOB_LOCK_TTL_MS,
}: AcquireJobLockParams): AcquireJobLockResult {
   const nowMs = Date.now();
   const existing = locks.get(name);

   if (existing && existing.expiresAtMs <= nowMs) {
      logger.warn(
         {
            lockName: name,
            previousOwner: existing.owner,
            expiredAt: new Date(existing.expiresAtMs).toISOString(),
            now: new Date(nowMs).toISOString(),
         },
         'Background job lock expired; reclaiming lock'
      );
      locks.delete(name);
   }

   if (locks.has(name)) {
      const current = locks.get(name)!;
      return {
         acquired: false,
         expiresAt: new Date(current.expiresAtMs).toISOString(),
         holder: current.owner,
      };
   }

   const expiresAtMs = nowMs + ttlMs;
   locks.set(name, { owner, expiresAtMs });

   return {
      acquired: true,
      expiresAt: new Date(expiresAtMs).toISOString(),
   };
}

export function releaseJobLock(name: string, owner?: string): boolean {
   const current = locks.get(name);
   if (!current) return false;

   if (owner && current.owner !== owner) {
      return false;
   }

   locks.delete(name);
   return true;
}

export function resetJobLocks(): void {
   locks.clear();
}
