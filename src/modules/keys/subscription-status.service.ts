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
import { cacheGetJson, cacheInvalidate, cacheSetJson } from '../../utils/redis.utils';
import { prisma } from '../../utils/prisma.utils';
import { isValidStellarAddress } from '../wallet/wallet.utils';

const CACHE_TTL_SECONDS = 30;

export interface SubscriptionStatus {
   key_id: string;
   wallet: string;
   is_active: boolean;
   expiry_timestamp: string | null;
   days_remaining: number;
}

export class SubscriptionStatusError extends Error {
   constructor(message: string, public readonly statusCode: number = 502) {
      super(message);
      this.name = 'SubscriptionStatusError';
   }
}

function fieldName(value: xdr.ScVal): string | null {
   const type = value.switch();
   if (type === xdr.ScValType.scvSymbol()) return value.sym().toString();
   if (type === xdr.ScValType.scvString()) return value.str().toString();
   return null;
}

function integerValue(value: xdr.ScVal): bigint {
   const type = value.switch();
   if (type === xdr.ScValType.scvU64()) return BigInt(value.u64().toString());
   if (type === xdr.ScValType.scvI64()) return BigInt(value.i64().toString());
   if (type === xdr.ScValType.scvU32()) return BigInt(value.u32());
   if (type === xdr.ScValType.scvI32()) return BigInt(value.i32());
   throw new SubscriptionStatusError('Subscription contract returned an invalid expiry');
}

function decodeSubscription(valueXdr: string, keyId: string, wallet: string): SubscriptionStatus {
   let value: xdr.ScVal;
   try {
      value = xdr.ScVal.fromXDR(valueXdr, 'base64');
   } catch {
      throw new SubscriptionStatusError('Subscription contract returned invalid data');
   }

   // Soroban Option::None is encoded as void; it represents a wallet that has
   // never subscribed, rather than an RPC failure.
   if (value.switch() === xdr.ScValType.scvVoid()) {
      return { key_id: keyId, wallet, is_active: false, expiry_timestamp: null, days_remaining: 0 };
   }
   if (value.switch() !== xdr.ScValType.scvMap()) {
      throw new SubscriptionStatusError('Subscription contract returned an invalid record');
   }

   const fields = new Map<string, xdr.ScVal>();
   for (const entry of value.map() ?? []) {
      const name = fieldName(entry.key());
      if (name) fields.set(name.toLowerCase().replace(/[^a-z]/g, ''), entry.val());
   }
   const expiry = fields.get('expirytimestamp') ?? fields.get('expiresat') ?? fields.get('expiry');
   if (!expiry) {
      throw new SubscriptionStatusError('Subscription contract response is missing expiry_timestamp');
   }

   const expirySeconds = integerValue(expiry);
   const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
   const reportedActive = fields.get('isactive');
   const activeFlag = reportedActive?.switch() === xdr.ScValType.scvBool()
      ? reportedActive.b()
      : true;
   const isActive = activeFlag && expirySeconds > nowSeconds;
   const daysRemaining = isActive
      ? Number((expirySeconds - nowSeconds + 86_399n) / 86_400n)
      : 0;

   return {
      key_id: keyId,
      wallet,
      is_active: isActive,
      expiry_timestamp: expirySeconds.toString(),
      days_remaining: daysRemaining,
   };
}

async function readSubscription(contractId: string, sourceWallet: string, wallet: string, keyId: string): Promise<SubscriptionStatus> {
   const accountResponse = await horizonGet(`/accounts/${encodeURIComponent(sourceWallet)}`);
   if (!accountResponse.ok) {
      throw new SubscriptionStatusError('Unable to load the contract caller account from Horizon');
   }
   const account = (await accountResponse.json()) as { sequence?: unknown };
   if (typeof account.sequence !== 'string' || !/^\d+$/.test(account.sequence)) {
      throw new SubscriptionStatusError('Horizon returned an invalid account sequence');
   }

   const passphrase = envConfig.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
   const transaction = new TransactionBuilder(new Account(sourceWallet, account.sequence), {
      fee: '100',
      networkPassphrase: passphrase,
   })
      .addOperation(new Contract(contractId).call('get_subscription', new Address(wallet).toScVal()))
      .setTimeout(300)
      .build()
      .toXDR();

   const controller = new AbortController();
   const timeout = setTimeout(() => controller.abort(), envConfig.DB_QUERY_TIMEOUT_MS);
   try {
      const response = await fetch(envConfig.STELLAR_SOROBAN_RPC_URL, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ jsonrpc: '2.0', id: 'subscription-status', method: 'simulateTransaction', params: { transaction } }),
         signal: controller.signal,
      });
      if (!response.ok) throw new SubscriptionStatusError(`Soroban RPC returned HTTP ${response.status}`);
      const envelope = (await response.json()) as {
         error?: { message?: string };
         result?: { results?: Array<{ xdr?: string; retval?: string }> };
      };
      if (envelope.error) throw new SubscriptionStatusError(envelope.error.message ?? 'Subscription contract call failed');
      const result = envelope.result?.results?.[0]?.retval ?? envelope.result?.results?.[0]?.xdr;
      if (!result) throw new SubscriptionStatusError('Subscription contract returned no data');
      return decodeSubscription(result, keyId, wallet);
   } finally {
      clearTimeout(timeout);
   }
}

export async function getSubscriptionStatus(keyId: string, walletAddress: string): Promise<SubscriptionStatus> {
   const wallet = walletAddress.trim().toUpperCase();
   if (!isValidStellarAddress(wallet)) throw new SubscriptionStatusError('A valid Stellar wallet is required', 400);

   const registeredKey = await prisma.registeredKey.findFirst({
      where: { OR: [{ id: keyId }, { keyAddress: keyId }] },
      select: { id: true, keyAddress: true, creatorWallet: true },
   });
   if (!registeredKey) throw new SubscriptionStatusError('Key not found', 404);

   const cacheKey = `subscription:status:${registeredKey.keyAddress}:${wallet}`;
   const cached = await cacheGetJson<SubscriptionStatus>(cacheKey);
   if (cached) return { ...cached, key_id: keyId };

   const status = await readSubscription(registeredKey.keyAddress, registeredKey.creatorWallet, wallet, keyId);
   await cacheSetJson(cacheKey, status, CACHE_TTL_SECONDS);
   return status;
}

export async function processSubscriptionCreatedEvent(event: Record<string, unknown>): Promise<void> {
   const keyId = String(event.keyId ?? event.key_id ?? event.creatorId ?? event.contractId ?? '');
   const wallet = String(event.actor ?? event.wallet ?? event.subscriber ?? '').trim().toUpperCase();
   if (!keyId || !wallet) return;

   const key = await prisma.registeredKey.findFirst({
      where: { OR: [{ id: keyId }, { keyAddress: keyId }] },
      select: { id: true, keyAddress: true },
   });
   if (key) {
      await cacheInvalidate(`subscription:status:${key.keyAddress}:${wallet}`);
   }

   const txHash = String(event.txHash ?? event.tx_hash ?? '');
   if (!txHash) return;
   await prisma.activityLog.upsert({
      where: { txHash_actor_type: { txHash, actor: wallet, type: 'subscription_created' } },
      update: {},
      create: {
         type: 'subscription_created',
         actor: wallet,
         keyId: key?.id ?? keyId,
         txHash,
         payload: { expiry_timestamp: event.expiryTimestamp ?? event.expiry_timestamp ?? null },
         timestamp: event.timestamp ? new Date(String(event.timestamp)) : new Date(),
      },
   });
}
