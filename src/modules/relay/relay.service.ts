import { randomUUID } from 'crypto';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-base';
import { envConfig } from '../../config';
import { horizonGet } from '../../clients/horizon.client';
import { sendTransaction } from '../../clients/soroban.client';
import { getRedis } from '../../utils/redis.utils';

const RESERVATION_TTL_SECONDS = 5 * 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RELAY_REQUESTS = 10;

function reservationKey(wallet: string): string {
   return `relay:nonce:${wallet}`;
}

function networkPassphrase(): string {
   return envConfig.STELLAR_NETWORK === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET;
}

export async function reserveNonce(walletAddress: string): Promise<string> {
   const wallet = walletAddress.trim().toUpperCase();
   const redis = getRedis();
   if (!redis) throw Object.assign(new Error('Nonce service is unavailable'), { statusCode: 503 });

   const key = reservationKey(wallet);
   const reserved = await redis.get(key);
   if (reserved) return reserved;

   const response = await horizonGet(
      `${envConfig.STELLAR_HORIZON_URL.replace(/\/$/, '')}/accounts/${encodeURIComponent(wallet)}`
   );
   if (response.status === 404) {
      throw Object.assign(new Error('Wallet does not exist on the Stellar network'), { statusCode: 404 });
   }
   if (!response.ok) throw Object.assign(new Error('Unable to read wallet sequence'), { statusCode: 502 });

   const account = (await response.json()) as { sequence?: string };
   if (!account.sequence || !/^\d+$/.test(account.sequence)) {
      throw Object.assign(new Error('Wallet sequence is unavailable'), { statusCode: 502 });
   }
   const nonce = (BigInt(account.sequence) + 1n).toString();
   const created = await redis.set(key, nonce, 'EX', RESERVATION_TTL_SECONDS, 'NX');
   if (created === 'OK') return nonce;

   const concurrentReservation = await redis.get(key);
   if (concurrentReservation) return concurrentReservation;
   throw Object.assign(new Error('Could not reserve a nonce; retry the request'), { statusCode: 409 });
}

async function enforceWalletRateLimit(wallet: string): Promise<void> {
   const redis = getRedis();
   if (!redis) throw Object.assign(new Error('Relay is unavailable'), { statusCode: 503 });
   const now = Date.now();
   const key = `relay:rate:${wallet}`;
   const result = await redis.eval(
      `local key = KEYS[1]
       local now = tonumber(ARGV[1])
       local cutoff = now - tonumber(ARGV[2])
       redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
       local count = redis.call('ZCARD', key)
       if count >= tonumber(ARGV[3]) then return 0 end
       redis.call('ZADD', key, now, ARGV[4])
       redis.call('PEXPIRE', key, ARGV[2])
       return 1`,
      1,
      key,
      String(now),
      String(RATE_LIMIT_WINDOW_MS),
      String(MAX_RELAY_REQUESTS),
      `${now}:${randomUUID()}`
   );
   if (result !== 1) throw Object.assign(new Error('Relay rate limit exceeded'), { statusCode: 429 });
}

export async function relaySignedTransaction(input: {
   wallet: string;
   nonce: string;
   signature: string;
   tx_params: string;
}): Promise<{ tx_hash: string }> {
   const wallet = input.wallet.trim().toUpperCase();
   const redis = getRedis();
   if (!redis) throw Object.assign(new Error('Relay is unavailable'), { statusCode: 503 });
   await enforceWalletRateLimit(wallet);

   const keypair = Keypair.fromPublicKey(wallet);
   const transaction = TransactionBuilder.fromXDR(input.tx_params, networkPassphrase());
   if (transaction.source !== wallet || transaction.sequence !== input.nonce) {
      throw Object.assign(new Error('Transaction wallet or sequence does not match the reservation'), { statusCode: 400 });
   }

   const signature = Buffer.from(input.signature, 'base64');
   if (signature.length !== 64 || !keypair.verify(transaction.hash(), signature)) {
      throw Object.assign(new Error('Invalid transaction signature'), { statusCode: 401 });
   }
   transaction.addSignature(wallet, input.signature);

   const reservation = await redis.get(reservationKey(wallet));
   if (reservation !== input.nonce) {
      throw Object.assign(new Error('Nonce reservation is missing or expired'), { statusCode: 409 });
   }

   const result = await sendTransaction(transaction.toXDR());
   if (result.status === 'ERROR' || !result.hash) {
      throw Object.assign(new Error('Soroban RPC rejected the transaction'), { statusCode: 502, details: result });
   }
   await redis.del(reservationKey(wallet));
   return { tx_hash: result.hash };
}
