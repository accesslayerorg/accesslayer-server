import { randomUUID } from 'crypto';
import {
   Keypair,
   Networks,
   StrKey,
   TransactionBuilder,
} from '@stellar/stellar-base';
import { envConfig } from '../../config';
import { horizonGet } from '../../clients/horizon.client';
import { submitContractCall } from '../contracts/contract.service';
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

function normalizeWallet(value: string): string {
   const wallet = value.trim();
   if (!StrKey.isValidEd25519PublicKey(wallet)) {
      throw Object.assign(new Error('A valid Stellar wallet is required'), {
         statusCode: 400,
      });
   }
   return wallet;
}

export async function reserveNonce(walletAddress: string): Promise<string> {
   const wallet = normalizeWallet(walletAddress);
   await enforceWalletRateLimit(wallet);
   const redis = getRedis();
   if (!redis)
      throw Object.assign(new Error('Nonce service is unavailable'), {
         statusCode: 503,
      });

   const key = reservationKey(wallet);
   const reserved = await redis.get(key);
   if (reserved && /^\d+$/.test(reserved)) return reserved;
   if (reserved?.startsWith('submitting:')) {
      throw Object.assign(
         new Error('A relay submission is already in progress'),
         { statusCode: 409 }
      );
   }

   const response = await horizonGet(
      `${envConfig.STELLAR_HORIZON_URL.replace(/\/$/, '')}/accounts/${encodeURIComponent(wallet)}`
   );
   if (response.status === 404) {
      throw Object.assign(
         new Error('Wallet does not exist on the Stellar network'),
         { statusCode: 404 }
      );
   }
   if (!response.ok)
      throw Object.assign(new Error('Unable to read wallet sequence'), {
         statusCode: 502,
      });

   const account = (await response.json()) as { sequence?: string };
   if (!account.sequence || !/^\d+$/.test(account.sequence)) {
      throw Object.assign(new Error('Wallet sequence is unavailable'), {
         statusCode: 502,
      });
   }
   const nonce = (BigInt(account.sequence) + 1n).toString();
   if (reserved?.startsWith('submitted:')) {
      if (BigInt(nonce) <= BigInt(reserved.slice('submitted:'.length))) {
         throw Object.assign(
            new Error('Previous transaction is awaiting ledger inclusion'),
            { statusCode: 409 }
         );
      }
      const replaced = await redis.eval(
         `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
          redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
          return 1`,
         1,
         key,
         reserved,
         nonce,
         String(RESERVATION_TTL_SECONDS)
      );
      if (replaced === 1) return nonce;
      throw Object.assign(new Error('Reservation changed; retry the request'), {
         statusCode: 409,
      });
   }
   const created = await redis.set(
      key,
      nonce,
      'EX',
      RESERVATION_TTL_SECONDS,
      'NX'
   );
   if (created === 'OK') return nonce;

   const concurrentReservation = await redis.get(key);
   if (concurrentReservation && /^\d+$/.test(concurrentReservation))
      return concurrentReservation;
   throw Object.assign(
      new Error('Could not reserve a nonce; retry the request'),
      { statusCode: 409 }
   );
}

async function enforceWalletRateLimit(wallet: string): Promise<void> {
   const redis = getRedis();
   if (!redis)
      throw Object.assign(new Error('Relay is unavailable'), {
         statusCode: 503,
      });
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
   if (result !== 1)
      throw Object.assign(new Error('Relay rate limit exceeded'), {
         statusCode: 429,
      });
}

export async function relaySignedTransaction(input: {
   wallet: string;
   nonce: string;
   signature: string;
   tx_params: string;
}): Promise<{ tx_hash: string }> {
   const wallet = normalizeWallet(input.wallet);
   const redis = getRedis();
   if (!redis)
      throw Object.assign(new Error('Relay is unavailable'), {
         statusCode: 503,
      });
   await enforceWalletRateLimit(wallet);

   const keypair = Keypair.fromPublicKey(wallet);
   let envelope;
   try {
      envelope = TransactionBuilder.fromXDR(
         input.tx_params,
         networkPassphrase()
      );
   } catch {
      throw Object.assign(new Error('Invalid transaction XDR'), {
         statusCode: 400,
      });
   }
   const transaction =
      'innerTransaction' in envelope ? envelope.innerTransaction : envelope;
   if (transaction.source !== wallet || transaction.sequence !== input.nonce) {
      throw Object.assign(
         new Error(
            'Transaction wallet or sequence does not match the reservation'
         ),
         { statusCode: 400 }
      );
   }

   const signature = Buffer.from(input.signature, 'base64');
   if (
      signature.length !== 64 ||
      !keypair.verify(transaction.hash(), signature)
   ) {
      throw Object.assign(new Error('Invalid transaction signature'), {
         statusCode: 401,
      });
   }
   const hasSignature = transaction.signatures.some(
      s =>
         s.hint().equals(keypair.signatureHint()) &&
         s.signature().equals(signature)
   );
   // Changing an inner envelope invalidates an existing fee-sponsor signature.
   if ('innerTransaction' in envelope && !hasSignature) {
      throw Object.assign(
         new Error(
            'Fee-bump inner transaction must already include the wallet signature'
         ),
         { statusCode: 400 }
      );
   }
   if (!hasSignature) transaction.addSignature(wallet, input.signature);

   const key = reservationKey(wallet);
   // Claim atomically before any network call; concurrent submits cannot both win.
   const claim = `submitting:${input.nonce}:${randomUUID()}`;
   const claimed = await redis.eval(
      `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
       redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
       return 1`,
      1,
      key,
      input.nonce,
      claim,
      String(RESERVATION_TTL_SECONDS)
   );
   if (claimed !== 1) {
      throw Object.assign(
         new Error('Nonce reservation is missing, expired, or already claimed'),
         { statusCode: 409 }
      );
   }

   // The shared service handles retries, persistence, and ledger confirmation.
   // On ambiguous failure leave the claim intact until expiry: fail closed.
   const result = await submitContractCall(
      {
         operation: 'relay',
         submitterWallet: wallet,
         transactionXdr: envelope.toXDR(),
      },
      {}
   );
   if (result.status !== 'CONFIRMED') {
      throw Object.assign(new Error('Relay transaction failed'), {
         statusCode: 502,
         details: { tx_hash: result.txHash, error_kind: result.errorKind },
      });
   }
   await redis.eval(
      `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
       redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
       return 1`,
      1,
      key,
      claim,
      `submitted:${input.nonce}`,
      String(RESERVATION_TTL_SECONDS)
   );
   return { tx_hash: result.txHash };
}
