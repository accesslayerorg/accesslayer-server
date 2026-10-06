// src/modules/vesting/vesting.service.ts
import { prisma } from '../../utils/prisma.utils';
import {
  cacheGetJson,
  cacheInvalidate,
  cacheSetJson,
} from '../../utils/redis.utils';

export class VestingNotFoundError extends Error {
  constructor(keyId: string, wallet: string) {
    super(`Vesting schedule not found for key ${keyId} and wallet ${wallet}`);
    this.name = 'VestingNotFoundError';
  }
}

export class KeyVestingNotFoundError extends Error {
  constructor(keyId: string) {
    super(`Vesting schedule not found for key ${keyId}`);
    this.name = 'KeyVestingNotFoundError';
  }
}

export const VESTING_CACHE_TTL_SECONDS = 60;
export const LEDGER_SECONDS = 5;

export interface VestingSchedule {
  keyId: string;
  wallet: string;
  totalKeys: string;
  startLedger: number;
  endLedger: number;
  claimedKeys: string;
  vestedAmount: string;
  claimableAmount: string;
  cliff: number;
  cliffLedger: number;
  duration: number;
  durationLedger: number;
  endDate: string | null;
}

export interface VestingClaimHistoryEntry {
  id: string;
  keyId: string;
  wallet: string;
  claimedAmount: string;
  txHash: string | null;
  ledger: number | null;
  claimedAt: string;
}

export interface KeyVestingSummary {
  keyId: string;
  currentLedger: number;
  totalKeys: string;
  totalClaimableAmount: string;
  totalClaimedKeys: string;
  cliff: number;
  cliffLedger: number;
  duration: number;
  durationLedger: number;
  endDate: string | null;
  schedules: VestingSchedule[];
}

export function getVestingCacheKey(keyId: string): string {
  return `key:vesting:${keyId}`;
}

export function getVestingHistoryCacheKey(keyId: string): string {
  return `key:vesting:${keyId}:history`;
}

function ledgerDurationToDate(ledgerDelta: number, anchorLedger: number): string | null {
  if (!Number.isFinite(ledgerDelta) || ledgerDelta < 0) {
    return null;
  }

  const seconds = ledgerDelta * LEDGER_SECONDS;
  return new Date((anchorLedger * LEDGER_SECONDS + seconds) * 1000).toISOString();
}

function calculateVestedAmount(
  total: bigint,
  start: number,
  end: number,
  currentLedger: number
): bigint {
  if (currentLedger >= end) {
    return total;
  }

  if (currentLedger <= start) {
    return 0n;
  }

  const elapsed = BigInt(currentLedger - start);
  const duration = BigInt(end - start);
  if (duration <= 0n) {
    return total;
  }

  return (total * elapsed) / duration;
}

function toVestingSchedule(
  schedule: {
    keyId: string;
    wallet: string;
    totalKeys: { toString(): string };
    startLedger: number;
    endLedger: number;
    claimedKeys: { toString(): string };
  },
  currentLedger: number
): VestingSchedule {
  const total = BigInt(schedule.totalKeys.toString());
  const claimed = BigInt(schedule.claimedKeys.toString());
  const vested = calculateVestedAmount(
    total,
    schedule.startLedger,
    schedule.endLedger,
    currentLedger
  );
  const claimable = vested > claimed ? vested - claimed : 0n;
  const durationLedger = Math.max(0, schedule.endLedger - schedule.startLedger);
  const endDate = ledgerDurationToDate(durationLedger, schedule.startLedger);

  return {
    keyId: schedule.keyId,
    wallet: schedule.wallet,
    totalKeys: total.toString(),
    startLedger: schedule.startLedger,
    endLedger: schedule.endLedger,
    claimedKeys: claimed.toString(),
    vestedAmount: vested.toString(),
    claimableAmount: claimable.toString(),
    cliff: schedule.startLedger,
    cliffLedger: schedule.startLedger,
    duration: durationLedger,
    durationLedger,
    endDate,
  };
}

export async function getVestingSchedule(
  keyId: string,
  wallet: string,
  currentLedger: number
): Promise<VestingSchedule> {
  const schedule = await prisma.vestingSchedule.findUnique({
    where: { keyId_wallet: { keyId, wallet } },
  });

  if (!schedule) {
    throw new VestingNotFoundError(keyId, wallet);
  }

  return toVestingSchedule(schedule, currentLedger);
}

export async function getKeyVestingSummary(
  keyId: string,
  currentLedger: number
): Promise<KeyVestingSummary> {
  const cacheKey = getVestingCacheKey(keyId);
  const cached = await cacheGetJson<KeyVestingSummary>(cacheKey);
  if (cached) {
    return cached;
  }

  const schedules = await prisma.vestingSchedule.findMany({
    where: { keyId },
    orderBy: [{ endLedger: 'asc' }, { wallet: 'asc' }],
  });

  if (schedules.length === 0) {
    throw new KeyVestingNotFoundError(keyId);
  }

  const normalizedSchedules = schedules.map(schedule =>
    toVestingSchedule(schedule, currentLedger)
  );
  const totalKeys = normalizedSchedules.reduce(
    (acc, item) => acc + BigInt(item.totalKeys),
    0n
  );
  const totalClaimedKeys = normalizedSchedules.reduce(
    (acc, item) => acc + BigInt(item.claimedKeys),
    0n
  );
  const totalClaimableAmount = normalizedSchedules.reduce(
    (acc, item) => acc + BigInt(item.claimableAmount),
    0n
  );
  const durationLedger = normalizedSchedules.reduce(
    (acc, item) => Math.max(acc, item.durationLedger),
    0
  );
  const cliffLedger = normalizedSchedules.reduce(
    (acc, item) => Math.min(acc, item.cliffLedger),
    Number.MAX_SAFE_INTEGER
  );
  const endDate = normalizedSchedules.reduce(
    (acc, item) => (acc && item.endDate ? new Date(acc) > new Date(item.endDate) ? acc : item.endDate : item.endDate ?? acc),
    null as string | null
  );

  const summary: KeyVestingSummary = {
    keyId,
    currentLedger,
    totalKeys: totalKeys.toString(),
    totalClaimableAmount: totalClaimableAmount.toString(),
    totalClaimedKeys: totalClaimedKeys.toString(),
    cliff: cliffLedger === Number.MAX_SAFE_INTEGER ? 0 : cliffLedger,
    cliffLedger: cliffLedger === Number.MAX_SAFE_INTEGER ? 0 : cliffLedger,
    duration: durationLedger,
    durationLedger,
    endDate,
    schedules: normalizedSchedules,
  };

  await cacheSetJson(cacheKey, summary, VESTING_CACHE_TTL_SECONDS);
  return summary;
}

export async function getKeyVestingHistory(
  keyId: string,
  limit = 20
): Promise<VestingClaimHistoryEntry[]> {
  const history = await prisma.vestingClaimHistory.findMany({
    where: { keyId },
    orderBy: [{ claimedAt: 'desc' }],
    take: Math.max(1, Math.min(limit, 100)),
  });

  return history.map(entry => ({
    id: entry.id,
    keyId: entry.keyId,
    wallet: entry.wallet,
    claimedAmount: entry.claimedAmount,
    txHash: entry.txHash,
    ledger: entry.ledger,
    claimedAt: entry.claimedAt.toISOString(),
  }));
}

export async function invalidateKeyVestingCache(keyId: string): Promise<void> {
  await cacheInvalidate(getVestingCacheKey(keyId), getVestingHistoryCacheKey(keyId));
}

export async function processVestingClaimEvent(event: {
  eventType?: string;
  keyId: string;
  wallet: string;
  claimedAmount: string;
  txHash?: string | null;
  ledger?: number | null;
}): Promise<void> {
  if (event.eventType && event.eventType !== 'VestingClaimed') {
    return;
  }

  const schedule = await prisma.vestingSchedule.findUnique({
    where: { keyId_wallet: { keyId: event.keyId, wallet: event.wallet } },
  });

  if (!schedule) {
    return;
  }

  await prisma.vestingClaimHistory.create({
    data: {
      vestingId: schedule.id,
      keyId: schedule.keyId,
      wallet: schedule.wallet,
      claimedAmount: event.claimedAmount,
      txHash: event.txHash ?? null,
      ledger: event.ledger ?? null,
    },
  });

  await invalidateKeyVestingCache(event.keyId);
}
