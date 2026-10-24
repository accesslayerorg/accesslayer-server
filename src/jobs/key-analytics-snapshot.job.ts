import {
   Account,
   Contract,
   Networks,
   TransactionBuilder,
   xdr,
} from '@stellar/stellar-base';
import { envConfig } from '../config';
import {
   defaultSorobanTransport,
   type SorobanPostJson,
} from '../clients/soroban.client';
import { logger } from '../utils/logger.utils';
import { prisma } from '../utils/prisma.utils';

type RegisteredKey = {
   id: string;
   keyAddress: string;
   creatorWallet: string;
};

type JsonValue =
   | string
   | number
   | boolean
   | null
   | JsonValue[]
   | { [key: string]: JsonValue };

type SnapshotRpcEnvelope = {
   error?: { code?: number; message?: string };
   result?: {
      error?: string;
      results?: Array<{ xdr?: string; retval?: string }>;
   };
};

export type KeyAnalyticsSnapshotResult = {
   scannedKeys: number;
   storedSnapshots: number;
   failedSnapshots: number;
};

export function getSnapshotDate(now: Date): Date {
   return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
   );
}

function getNetworkPassphrase(): string {
   return envConfig.STELLAR_NETWORK === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET;
}

function buildSnapshotTransaction(key: RegisteredKey): string {
   const operation = new Contract(key.keyAddress).call(
      'take_daily_snapshot',
      xdr.ScVal.scvString(key.keyAddress)
   );

   return new TransactionBuilder(new Account(key.creatorWallet, '0'), {
      fee: '100',
      networkPassphrase: getNetworkPassphrase(),
   })
      .addOperation(operation)
      .setTimeout(300)
      .build()
      .toXDR();
}

function decodeInteger128(value: xdr.ScVal, signed: boolean): string {
   const parts = signed ? value.i128() : value.u128();
   const words = parts as unknown as {
      hi(): { toString(): string };
      lo(): { toString(): string };
   };
   const high = BigInt(words.hi().toString());
   const low = BigInt.asUintN(64, BigInt(words.lo().toString()));
   return ((high << 64n) | low).toString();
}

function getMapKey(value: xdr.ScVal): string {
   const type = value.switch();
   if (type === xdr.ScValType.scvString()) return value.str().toString();
   if (type === xdr.ScValType.scvSymbol()) return value.sym().toString();
   throw new Error('Snapshot metrics contain a non-string map key');
}

function decodeScVal(value: xdr.ScVal): JsonValue {
   const type = value.switch();
   if (type === xdr.ScValType.scvVoid()) return null;
   if (type === xdr.ScValType.scvBool()) return value.b();
   if (type === xdr.ScValType.scvU32()) return value.u32();
   if (type === xdr.ScValType.scvI32()) return value.i32();
   if (type === xdr.ScValType.scvU64()) return value.u64().toString();
   if (type === xdr.ScValType.scvI64()) return value.i64().toString();
   if (type === xdr.ScValType.scvU128()) return decodeInteger128(value, false);
   if (type === xdr.ScValType.scvI128()) return decodeInteger128(value, true);
   if (type === xdr.ScValType.scvString()) return value.str().toString();
   if (type === xdr.ScValType.scvSymbol()) return value.sym().toString();
   if (type === xdr.ScValType.scvVec()) {
      return (value.vec() ?? []).map(decodeScVal);
   }
   if (type === xdr.ScValType.scvMap()) {
      const metrics: { [key: string]: JsonValue } = {};
      for (const entry of value.map() ?? []) {
         metrics[getMapKey(entry.key())] = decodeScVal(entry.val());
      }
      return metrics;
   }
   throw new Error(`Unsupported snapshot metric type: ${type.name}`);
}

async function fetchSnapshotMetrics(
   key: RegisteredKey,
   postJson: SorobanPostJson = defaultSorobanTransport
): Promise<JsonValue> {
   const transaction = buildSnapshotTransaction(key);
   const envelope = (await postJson(envConfig.STELLAR_SOROBAN_RPC_URL, {
      jsonrpc: '2.0',
      id: 'key-analytics-snapshot',
      method: 'simulateTransaction',
      params: { transaction },
   })) as SnapshotRpcEnvelope;

   if (envelope.error) {
      throw new Error(
         `Soroban RPC error ${envelope.error.code ?? 'unknown'}: ${envelope.error.message ?? 'unknown error'}`
      );
   }
   if (envelope.result?.error) {
      throw new Error(`Snapshot simulation failed: ${envelope.result.error}`);
   }

   const resultXdr =
      envelope.result?.results?.[0]?.retval ??
      envelope.result?.results?.[0]?.xdr;
   if (!resultXdr) {
      throw new Error('Snapshot simulation returned no metrics');
   }

   const result = xdr.ScVal.fromXDR(resultXdr, 'base64');
   const decoded = decodeScVal(result);
   if (
      decoded === null ||
      typeof decoded !== 'object' ||
      Array.isArray(decoded)
   ) {
      throw new Error('Snapshot metrics must be returned as a contract map');
   }
   return decoded;
}

function nextRetryAt(now: Date, retryExpiresAt: Date): Date {
   const configuredRetryAt = new Date(
      now.getTime() +
         envConfig.KEY_ANALYTICS_SNAPSHOT_RETRY_INTERVAL_MINUTES * 60 * 1000
   );
   return configuredRetryAt < retryExpiresAt
      ? configuredRetryAt
      : retryExpiresAt;
}

async function recordSnapshotFailure(
   keyId: string,
   snapshotDate: Date,
   error: unknown,
   now: Date
): Promise<void> {
   const errorMessage =
      error instanceof Error ? error.message : String(error);
   const retryExpiresAt = new Date(
      now.getTime() +
         envConfig.KEY_ANALYTICS_SNAPSHOT_RETRY_WINDOW_MINUTES * 60 * 1000
   );

   await prisma.snapshotError.upsert({
      where: { keyId_snapshotDate: { keyId, snapshotDate } },
      create: {
         keyId,
         snapshotDate,
         error: errorMessage,
         retryAt: nextRetryAt(now, retryExpiresAt),
         retryExpiresAt,
      },
      update: {
         error: errorMessage,
         retryAt: nextRetryAt(now, retryExpiresAt),
         retryCount: { increment: 1 },
         resolvedAt: null,
      },
   });
}

async function storeSnapshot(
   keyId: string,
   snapshotDate: Date,
   metrics: JsonValue
): Promise<void> {
   await prisma.keySnapshot.upsert({
      where: { keyId_snapshotDate: { keyId, snapshotDate } },
      create: { keyId, snapshotDate, metrics },
      update: { metrics },
   });
   await prisma.snapshotError.updateMany({
      where: { keyId, snapshotDate, resolvedAt: null },
      data: { resolvedAt: new Date() },
   });
}

async function takeAndStoreSnapshot(
   key: RegisteredKey,
   snapshotDate: Date,
   now: Date
): Promise<boolean> {
   try {
      const existingSnapshot = await prisma.keySnapshot.findUnique({
         where: {
            keyId_snapshotDate: {
               keyId: key.keyAddress,
               snapshotDate,
            },
         },
         select: { id: true },
      });
      if (existingSnapshot) {
         await prisma.snapshotError.updateMany({
            where: {
               keyId: key.keyAddress,
               snapshotDate,
               resolvedAt: null,
            },
            data: { resolvedAt: now },
         });
         return true;
      }

      const metrics = await fetchSnapshotMetrics(key);
      await storeSnapshot(key.keyAddress, snapshotDate, metrics);
      return true;
   } catch (error) {
      logger.error(
         { keyId: key.keyAddress, error },
         'key-analytics-snapshot: snapshot failed'
      );
      try {
         await recordSnapshotFailure(
            key.keyAddress,
            snapshotDate,
            error,
            now
         );
      } catch (recordError) {
         logger.error(
            { keyId: key.keyAddress, error: recordError },
            'key-analytics-snapshot: failed to persist snapshot error'
         );
      }
      return false;
   }
}

export async function collectDailyKeyAnalyticsSnapshots(
   now: Date = new Date()
): Promise<KeyAnalyticsSnapshotResult> {
   const snapshotDate = getSnapshotDate(now);
   const batchSize = envConfig.KEY_ANALYTICS_SNAPSHOT_BATCH_SIZE;
   let cursorId: string | undefined;
   let scannedKeys = 0;
   let storedSnapshots = 0;
   let failedSnapshots = 0;

   for (;;) {
      const keys: RegisteredKey[] = await prisma.registeredKey.findMany({
         where: { status: 'ACTIVE' },
         select: { id: true, keyAddress: true, creatorWallet: true },
         orderBy: { id: 'asc' },
         take: batchSize,
         ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      });
      if (keys.length === 0) break;

      for (const key of keys) {
         scannedKeys += 1;
         if (await takeAndStoreSnapshot(key, snapshotDate, now)) {
            storedSnapshots += 1;
         } else {
            failedSnapshots += 1;
         }
      }

      cursorId = keys[keys.length - 1].id;
      if (keys.length < batchSize) break;
   }

   const result = { scannedKeys, storedSnapshots, failedSnapshots };
   logger.info(result, 'key-analytics-snapshot: daily collection completed');
   return result;
}

export async function retryFailedKeyAnalyticsSnapshots(
   now: Date = new Date()
): Promise<KeyAnalyticsSnapshotResult> {
   const batchSize = envConfig.KEY_ANALYTICS_SNAPSHOT_BATCH_SIZE;
   let scannedKeys = 0;
   let storedSnapshots = 0;
   let failedSnapshots = 0;

   for (;;) {
      const failures = await prisma.snapshotError.findMany({
         where: {
            resolvedAt: null,
            retryAt: { lte: now },
            retryExpiresAt: { gt: now },
         },
         orderBy: [{ retryAt: 'asc' }, { id: 'asc' }],
         take: batchSize,
         select: {
            id: true,
            keyId: true,
            snapshotDate: true,
         },
      });
      if (failures.length === 0) break;

      for (const failure of failures) {
         scannedKeys += 1;
         const key = await prisma.registeredKey.findUnique({
            where: { keyAddress: failure.keyId },
            select: { id: true, keyAddress: true, creatorWallet: true },
         });
         if (!key) {
            const missingKeyError = new Error(
               'Registered key no longer exists'
            );
            try {
               await recordSnapshotFailure(
                  failure.keyId,
                  failure.snapshotDate,
                  missingKeyError,
                  now
               );
            } catch (error) {
               logger.error(
                  { keyId: failure.keyId, error },
                  'key-analytics-snapshot: failed to record missing key retry'
               );
            }
            failedSnapshots += 1;
            continue;
         }

         if (
            await takeAndStoreSnapshot(key, failure.snapshotDate, now)
         ) {
            storedSnapshots += 1;
         } else {
            failedSnapshots += 1;
         }
      }
   }

   const result = { scannedKeys, storedSnapshots, failedSnapshots };
   if (scannedKeys > 0) {
      logger.info(result, 'key-analytics-snapshot: retry pass completed');
   }
   return result;
}

let dailyTimer: NodeJS.Timeout | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let dailyRunInProgress = false;
let retryRunInProgress = false;

export function startKeyAnalyticsSnapshotJob(): void {
   if (!envConfig.KEY_ANALYTICS_SNAPSHOT_ENABLED) {
      logger.info('Key analytics snapshot job is disabled');
      return;
   }

   const runDaily = async () => {
      if (dailyRunInProgress) return;
      dailyRunInProgress = true;
      try {
         await collectDailyKeyAnalyticsSnapshots();
      } catch (error) {
         logger.error(
            { error },
            'key-analytics-snapshot: daily collection crashed'
         );
      } finally {
         dailyRunInProgress = false;
      }
   };

   const runRetries = async () => {
      if (retryRunInProgress) return;
      retryRunInProgress = true;
      try {
         await retryFailedKeyAnalyticsSnapshots();
      } catch (error) {
         logger.error(
            { error },
            'key-analytics-snapshot: retry pass crashed'
         );
      } finally {
         retryRunInProgress = false;
      }
   };

   void runDaily();
   void runRetries();
   dailyTimer = setInterval(
      () => void runDaily(),
      envConfig.KEY_ANALYTICS_SNAPSHOT_INTERVAL_MINUTES * 60 * 1000
   );
   retryTimer = setInterval(
      () => void runRetries(),
      envConfig.KEY_ANALYTICS_SNAPSHOT_RETRY_INTERVAL_MINUTES * 60 * 1000
   );
   dailyTimer.unref();
   retryTimer.unref();

   logger.info(
      {
         intervalMinutes: envConfig.KEY_ANALYTICS_SNAPSHOT_INTERVAL_MINUTES,
         batchSize: envConfig.KEY_ANALYTICS_SNAPSHOT_BATCH_SIZE,
         retryIntervalMinutes:
            envConfig.KEY_ANALYTICS_SNAPSHOT_RETRY_INTERVAL_MINUTES,
         retryWindowMinutes:
            envConfig.KEY_ANALYTICS_SNAPSHOT_RETRY_WINDOW_MINUTES,
      },
      'Key analytics snapshot job started'
   );
}

export function stopKeyAnalyticsSnapshotJob(): void {
   if (dailyTimer) {
      clearInterval(dailyTimer);
      dailyTimer = null;
   }
   if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
   }
   logger.info('Key analytics snapshot job stopped');
}
