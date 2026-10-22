import {
   Account,
   Address,
   Contract,
   Networks,
   TransactionBuilder,
   nativeToScVal,
   scValToNative,
   xdr,
} from '@stellar/stellar-base';
import { createHash } from 'crypto';
import { envConfig } from '../../config';
import { defaultSorobanTransport } from '../../clients/soroban.client';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';

export class InvoiceProtocolUnavailableError extends Error {
   constructor(message = 'Invoice protocol contract is unavailable') {
      super(message);
      this.name = 'InvoiceProtocolUnavailableError';
   }
}

export class TransferBlockedError extends Error {
   readonly code = 'TransferBlocked';
   constructor(
      public readonly reason: string,
      public readonly restrictionType: string
   ) {
      super(reason);
      this.name = 'TransferBlockedError';
   }
}

export const invoiceNetwork = () =>
   envConfig.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

export function protocolCacheKey(kind: string, ...parts: string[]): string {
   return `invoice-protocol:${kind}:${createHash('sha256')
      .update(JSON.stringify([envConfig.STELLAR_NETWORK, ...parts]))
      .digest('hex')}`;
}

/** Read-only simulation: never signs or broadcasts a transaction. */
export async function readInvoiceContract(
   contractId: string | undefined,
   source: string,
   method: string,
   args: xdr.ScVal[]
): Promise<unknown> {
   if (!contractId) throw new InvoiceProtocolUnavailableError();
   try {
      const transaction = new TransactionBuilder(new Account(source, '0'), {
         fee: '100',
         networkPassphrase: invoiceNetwork(),
      })
         .addOperation(new Contract(contractId).call(method, ...args))
         .setTimeout(300)
         .build()
         .toXDR();
      const envelope = (await defaultSorobanTransport(
         envConfig.STELLAR_SOROBAN_RPC_URL,
         {
            jsonrpc: '2.0',
            id: method,
            method: 'simulateTransaction',
            params: { transaction },
         }
      )) as {
         error?: unknown;
         result?: {
            error?: unknown;
            results?: { xdr?: string; retval?: string }[];
         };
      };
      const result = envelope.result;
      const value = result?.results?.[0]?.xdr ?? result?.results?.[0]?.retval;
      if (envelope.error || result?.error || !value)
         throw new Error('Simulation failed');
      return scValToNative(xdr.ScVal.fromXDR(value, 'base64'));
   } catch (_error) {
      // A failed or malformed read must never be interpreted as permission.
      throw new InvoiceProtocolUnavailableError(`Unable to read ${method}`);
   }
}

export interface IssuerScoreValue {
   score: number;
   tier: string;
}
export function parseIssuerScore(value: unknown): IssuerScoreValue {
   const row = value as Record<string, unknown> | null;
   if (
      !row ||
      !['number', 'bigint', 'string'].includes(typeof row.score) ||
      (typeof row.score === 'string' && !/^(0|[1-9]\d*)$/.test(row.score))
   ) {
      throw new InvoiceProtocolUnavailableError(
         'Invalid issuer score response'
      );
   }
   const score = Number(row?.score);
   if (
      !row ||
      !Number.isSafeInteger(score) ||
      score < 0 ||
      score > 2147483647 ||
      typeof row.tier !== 'string' ||
      !row.tier
   ) {
      throw new InvoiceProtocolUnavailableError(
         'Invalid issuer score response'
      );
   }
   return { score, tier: row.tier };
}

export function issuerCacheKey(wallet: string, eventId: string): string {
   return protocolCacheKey(
      'score',
      envConfig.ISSUER_REPUTATION_CONTRACT_ID ?? '',
      wallet,
      eventId
   );
}

export async function getIssuerScore(
   wallet: string,
   eventId: string
): Promise<IssuerScoreValue> {
   // Versioning prevents a read that races an indexed update from repopulating
   // the new generation with a stale result, even across API processes.
   const key = issuerCacheKey(wallet, eventId);
   const cached = await cacheGetJson<IssuerScoreValue>(key);
   if (cached) return parseIssuerScore(cached);
   const result = parseIssuerScore(
      await readInvoiceContract(
         envConfig.ISSUER_REPUTATION_CONTRACT_ID,
         wallet,
         'get_issuer_score',
         [new Address(wallet).toScVal()]
      )
   );
   await cacheSetJson(key, result, 60);
   return result;
}

export interface TransferDecision {
   allowed: boolean;
   reason: string | null;
   restriction_type: string | null;
}

export function parseTransferDecision(value: unknown): TransferDecision {
   if (value === true)
      return { allowed: true, reason: null, restriction_type: null };
   const row = value as Record<string, unknown> | null;
   if (!row || typeof row.allowed !== 'boolean') {
      throw new InvoiceProtocolUnavailableError(
         'Invalid transfer restriction response'
      );
   }
   if (row.allowed)
      return { allowed: true, reason: null, restriction_type: null };
   if (
      typeof row.reason !== 'string' ||
      !row.reason ||
      typeof row.restriction_type !== 'string' ||
      !row.restriction_type
   ) {
      throw new InvoiceProtocolUnavailableError(
         'Blocked transfer is missing its reason or restriction type'
      );
   }
   return {
      allowed: false,
      reason: row.reason,
      restriction_type: row.restriction_type,
   };
}

export function transferCacheKey(
   from: string,
   to: string,
   invoiceId: string
): string {
   return protocolCacheKey(
      'transfer',
      envConfig.INVOICE_TRANSFER_CONTRACT_ID ?? '',
      from,
      to,
      invoiceId
   );
}

export const invalidateTransferCheck = (
   from: string,
   to: string,
   invoiceId: string
) => cacheInvalidate(transferCacheKey(from, to, invoiceId));

export async function checkInvoiceTransfer(
   from: string,
   to: string,
   invoiceId: string
): Promise<TransferDecision> {
   const key = transferCacheKey(from, to, invoiceId);
   const cached = await cacheGetJson<TransferDecision>(key);
   if (cached) return parseTransferDecision(cached);
   const result = parseTransferDecision(
      await readInvoiceContract(
         envConfig.INVOICE_TRANSFER_CONTRACT_ID,
         to,
         'check_transfer',
         [
            new Address(from).toScVal(),
            new Address(to).toScVal(),
            nativeToScVal(BigInt(invoiceId), { type: 'u64' }),
         ]
      )
   );
   await cacheSetJson(key, result, 60);
   return result;
}

export async function assertInvoiceTransferAllowed(
   from: string,
   to: string,
   invoiceId: string
): Promise<void> {
   const result = await checkInvoiceTransfer(from, to, invoiceId);
   if (!result.allowed)
      throw new TransferBlockedError(result.reason!, result.restriction_type!);
}
