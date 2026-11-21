// src/modules/vesting/vesting.service.ts
import { prisma } from '../../utils/prisma.utils';
import {
  cacheGetJson,
  cacheInvalidate,
  cacheSetJson,
} from '../../utils/redis.utils';
import {
  Account,
  Address,
  Contract,
  Networks,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-base';
import { envConfig } from '../../config';
import { horizonGet } from '../../clients/horizon.client';

export class VestingNotFoundError extends Error {
  constructor(keyId: string, wallet: string) {
    super(`Vesting schedule not found for key ${keyId} and wallet ${wallet}`);
    this.name = 'VestingNotFoundError';
  }
}

export class WalletVestingNotFoundError extends Error {
  constructor(wallet: string) {
    super(`No active vesting schedules found for wallet ${wallet}`);
    this.name = 'WalletVestingNotFoundError';
  }
}

export class VestingContractUnavailableError extends Error {
  constructor(message = 'Unable to read vesting state from the contract') {
    super(message);
    this.name = 'VestingContractUnavailableError';
  }
}

export class KeyVestingNotFoundError extends Error {
  constructor(keyId: string) {
    super(`Vesting schedule not found for key ${keyId}`);
    this.name = 'KeyVestingNotFoundError';
  }
}

export const VESTING_CACHE_TTL_SECONDS = 60;
export const WALLET_VESTING_CACHE_TTL_SECONDS = 30;
export const LEDGER_SECONDS = 5;

export interface WalletVestingTranche {
  total: string;
  claimed: string;
  claimable_now: string;
  cliff_timestamp: string;
  start_timestamp: string;
  duration_seconds: string;
}

export interface WalletVestingSchedule {
  vest_id: string;
  key_id: string;
  total: string;
  claimed: string;
  claimable_now: string;
  cliff_seconds_remaining: number;
  next_unlock: string | null;
  tranches: WalletVestingTranche[];
}

interface OnChainVestingInfo {
  totalAllocation: bigint;
  claimedAmount: bigint;
  claimableAmount: bigint;
  cliffTimestamp: bigint;
  startTimestamp: bigint;
  durationSeconds: bigint;
}

interface VestingContractMapping {
  id: string;
  keyAddress: string;
  creatorWallet: string;
}

const WALLET_VESTING_CACHE_KEY = (wallet: string) =>
  `vesting:wallet:${wallet}:list`;

function getScValName(value: xdr.ScVal): string | null {
  const type = value.switch();
  if (type === xdr.ScValType.scvSymbol()) return value.sym().toString();
  if (type === xdr.ScValType.scvString()) return value.str().toString();
  return null;
}

function getScValInteger(value: xdr.ScVal): bigint {
  const type = value.switch();
  if (type === xdr.ScValType.scvI128()) {
    const parts = value.i128() as unknown as {
      hi(): { toString(): string };
      lo(): { toString(): string };
    };
    return (
      (BigInt(parts.hi().toString()) << 64n) |
      BigInt.asUintN(64, BigInt(parts.lo().toString()))
    );
  }
  if (type === xdr.ScValType.scvU64()) return BigInt(value.u64().toString());
  if (type === xdr.ScValType.scvI64()) return BigInt(value.i64().toString());
  if (type === xdr.ScValType.scvU32()) return BigInt(value.u32());
  if (type === xdr.ScValType.scvI32()) return BigInt(value.i32());
  throw new VestingContractUnavailableError('Contract returned a non-integer vesting field');
}

function decodeVestingInfo(returnValueXdr: string): OnChainVestingInfo {
  let returnValue: xdr.ScVal;
  try {
    returnValue = xdr.ScVal.fromXDR(returnValueXdr, 'base64');
  } catch {
    throw new VestingContractUnavailableError('Contract returned invalid vesting data');
  }

  if (returnValue.switch() !== xdr.ScValType.scvMap()) {
    throw new VestingContractUnavailableError('Contract returned an invalid vesting record');
  }

  const fields = new Map<string, xdr.ScVal>();
  for (const entry of returnValue.map() ?? []) {
    const name = getScValName(entry.key());
    if (name) fields.set(name.replace(/_/g, '').toLowerCase(), entry.val());
  }

  const readField = (name: string): bigint => {
    const value = fields.get(name);
    if (!value) {
      throw new VestingContractUnavailableError(
        `Contract vesting response is missing ${name}`
      );
    }
    return getScValInteger(value);
  };

  return {
    totalAllocation: readField('totalallocation'),
    claimedAmount: readField('claimedamount'),
    claimableAmount: readField('claimableamount'),
    cliffTimestamp: readField('clifftimestamp'),
    startTimestamp: readField('starttimestamp'),
    durationSeconds: readField('durationsecs'),
  };
}

async function getAccountSequence(wallet: string): Promise<string> {
  const response = await horizonGet(`/accounts/${encodeURIComponent(wallet)}`);
  if (!response.ok) {
    throw new VestingContractUnavailableError(
      'Unable to load the contract caller account from Horizon'
    );
  }
  const account = (await response.json()) as { sequence?: unknown };
  if (typeof account.sequence !== 'string' || !/^\d+$/.test(account.sequence)) {
    throw new VestingContractUnavailableError(
      'Horizon returned an invalid contract caller sequence'
    );
  }
  return account.sequence;
}

async function fetchOnChainVestingInfo(
  contract: VestingContractMapping,
  beneficiary: string,
  sourceSequence: string
): Promise<OnChainVestingInfo> {
  const networkPassphrase =
    envConfig.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  const transaction = new TransactionBuilder(
    new Account(contract.creatorWallet, sourceSequence),
    { fee: '100', networkPassphrase }
  )
    .addOperation(
      new Contract(contract.keyAddress).call(
        'get_vesting_info',
        new Address(contract.creatorWallet).toScVal(),
        new Address(beneficiary).toScVal()
      )
    )
    .setTimeout(300)
    .build()
    .toXDR();

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    envConfig.DB_QUERY_TIMEOUT_MS
  );

  try {
    const response = await fetch(envConfig.STELLAR_SOROBAN_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'vesting-info',
        method: 'simulateTransaction',
        params: { transaction },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new VestingContractUnavailableError(
        `Soroban RPC returned HTTP ${response.status}`
      );
    }

    const envelope = (await response.json()) as {
      error?: { message?: string };
      result?: {
        results?: Array<{ xdr?: string; retval?: string }>;
      };
    };
    if (envelope.error) {
      throw new VestingContractUnavailableError(
        envelope.error.message ?? 'Soroban RPC rejected the vesting query'
      );
    }
    const returnValue =
      envelope.result?.results?.[0]?.retval ??
      envelope.result?.results?.[0]?.xdr;
    if (!returnValue) {
      throw new VestingContractUnavailableError(
        'Soroban RPC returned no vesting data'
      );
    }
    return decodeVestingInfo(returnValue);
  } finally {
    clearTimeout(timeout);
  }
}

function calculateNextUnlock(
  info: OnChainVestingInfo,
  nowSeconds: bigint
): string | null {
  if (info.claimableAmount + info.claimedAmount >= info.totalAllocation) {
    return null;
  }
  if (nowSeconds < info.cliffTimestamp) {
    return new Date(Number(info.cliffTimestamp) * 1000).toISOString();
  }
  if (info.durationSeconds === 0n || info.totalAllocation <= 0n) {
    return null;
  }

  const nextVestedAmount =
    info.claimableAmount + info.claimedAmount + 1n;
  const unlockOffset =
    (nextVestedAmount * info.durationSeconds + info.totalAllocation - 1n) /
    info.totalAllocation;
  const nextUnlock = info.startTimestamp + unlockOffset;
  const timestamp = nextUnlock > info.cliffTimestamp
    ? nextUnlock
    : info.cliffTimestamp;
  return new Date(Number(timestamp) * 1000).toISOString();
}

function toWalletVestingSchedule(
  vestId: string,
  keyId: string,
  info: OnChainVestingInfo,
  nowSeconds: bigint
): WalletVestingSchedule {
  const cliffRemaining = info.cliffTimestamp - nowSeconds;
  return {
    vest_id: vestId,
    key_id: keyId,
    total: info.totalAllocation.toString(),
    claimed: info.claimedAmount.toString(),
    claimable_now: info.claimableAmount.toString(),
    cliff_seconds_remaining: Number(cliffRemaining > 0n ? cliffRemaining : 0n),
    next_unlock: calculateNextUnlock(info, nowSeconds),
    tranches: [
      {
        total: info.totalAllocation.toString(),
        claimed: info.claimedAmount.toString(),
        claimable_now: info.claimableAmount.toString(),
        cliff_timestamp: info.cliffTimestamp.toString(),
        start_timestamp: info.startTimestamp.toString(),
        duration_seconds: info.durationSeconds.toString(),
      },
    ],
  };
}

async function getVestingContractMappings(
  keyIds: string[]
): Promise<Map<string, VestingContractMapping>> {
  const keys = await prisma.registeredKey.findMany({
    where: {
      OR: [{ id: { in: keyIds } }, { keyAddress: { in: keyIds } }],
    },
    select: { id: true, keyAddress: true, creatorWallet: true },
  });
  const mappings = new Map<string, VestingContractMapping>();
  for (const key of keys) {
    mappings.set(key.id, key);
    mappings.set(key.keyAddress, key);
  }
  return mappings;
}

export async function getWalletVestingSchedules(
  wallet: string
): Promise<WalletVestingSchedule[]> {
  const cacheKey = WALLET_VESTING_CACHE_KEY(wallet);
  const cached = await cacheGetJson<WalletVestingSchedule[]>(cacheKey);
  if (cached !== null) return cached;

  const schedules = await prisma.vestingSchedule.findMany({
    where: { wallet },
    orderBy: [{ keyId: 'asc' }, { id: 'asc' }],
  });
  const activeSchedules = schedules.filter(
    schedule =>
      BigInt(schedule.totalKeys.toString()) >
      BigInt(schedule.claimedKeys.toString())
  );
  if (activeSchedules.length === 0) {
    await cacheSetJson(cacheKey, [], WALLET_VESTING_CACHE_TTL_SECONDS);
    return [];
  }

  const keyIds = [...new Set(activeSchedules.map(schedule => schedule.keyId))];
  const mappings = await getVestingContractMappings(keyIds);
  const sequences = new Map<string, Promise<string>>();
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const results = await Promise.all(
    activeSchedules.map(async schedule => {
      const contract = mappings.get(schedule.keyId);
      if (!contract) {
        throw new VestingContractUnavailableError(
          `No registered creator contract found for vesting key ${schedule.keyId}`
        );
      }
      let sequence = sequences.get(contract.creatorWallet);
      if (!sequence) {
        sequence = getAccountSequence(contract.creatorWallet);
        sequences.set(contract.creatorWallet, sequence);
      }
      const info = await fetchOnChainVestingInfo(
        contract,
        wallet,
        await sequence
      );
      if (info.totalAllocation <= info.claimedAmount) return null;
      return toWalletVestingSchedule(schedule.id, schedule.keyId, info, nowSeconds);
    })
  );

  const activeResults = results.filter(
    (schedule): schedule is WalletVestingSchedule => schedule !== null
  );
  await cacheSetJson(
    cacheKey,
    activeResults,
    WALLET_VESTING_CACHE_TTL_SECONDS
  );
  return activeResults;
}

export async function getWalletVestingSchedule(
  wallet: string,
  vestId: string
): Promise<WalletVestingSchedule> {
  const schedules = await getWalletVestingSchedules(wallet);
  const schedule = schedules.find(item => item.vest_id === vestId);
  if (!schedule) throw new WalletVestingNotFoundError(wallet);
  return schedule;
}

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

export async function invalidateKeyVestingCache(
  keyId: string,
  wallet?: string
): Promise<void> {
  await cacheInvalidate(
    getVestingCacheKey(keyId),
    getVestingHistoryCacheKey(keyId),
    ...(wallet ? [`vesting:wallet:${wallet}:*`] : [])
  );
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

  await invalidateKeyVestingCache(event.keyId, event.wallet);
}
