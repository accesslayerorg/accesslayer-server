import {
   Account,
   Address,
   Contract,
   Networks,
   TransactionBuilder,
   xdr,
} from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { horizonGet } from '../../clients/horizon.client';
import {
   encodeCursor,
   decodeCursor,
   CursorChecksumError,
} from '../../utils/cursor.utils';

const STROOPS_PER_XLM = 10_000_000n;
const MAX_REFERRAL_HISTORY_PAGE_SIZE = 100;

export class ReferralContractUnavailableError extends Error {
   constructor(message = 'Referral contract state is unavailable') {
      super(message);
      this.name = 'ReferralContractUnavailableError';
   }
}

export class ReferralKeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Referral key ${keyId} was not found`);
      this.name = 'ReferralKeyNotFoundError';
   }
}

export class NothingToClaimError extends Error {
   constructor() {
      super('No referral rewards are claimable for this key');
      this.name = 'NothingToClaimError';
   }
}

export interface ReferralHistoryQuery {
   limit: number;
   cursor?: string;
}

export interface ReferralHistoryItem {
   id: string;
   keyId: string;
   amountXlm: number;
   txHash: string | null;
   eventIndex: number | null;
   refereeAddress: string | null;
   timestamp: string;
}

export interface ReferralHistoryPage {
   items: ReferralHistoryItem[];
   nextCursor: string | null;
}

interface ReferralHistoryCursor {
   createdAt: string;
   id: string;
}

function decodeHistoryCursor(cursor: string | undefined): ReferralHistoryCursor | null {
   if (!cursor) return null;
   try {
      const payload = decodeCursor<ReferralHistoryCursor>(cursor);
      if (
         typeof payload.createdAt !== 'string' ||
         Number.isNaN(new Date(payload.createdAt).getTime()) ||
         typeof payload.id !== 'string' ||
         !payload.id
      ) {
         throw new Error('Invalid cursor payload');
      }
      return payload;
   } catch {
      throw new CursorChecksumError('Invalid referral history cursor');
   }
}

export async function getReferralHistory(
   wallet: string,
   query: ReferralHistoryQuery
): Promise<ReferralHistoryPage> {
   const cursor = decodeHistoryCursor(query.cursor);
   const limit = Math.min(
      Math.max(Math.trunc(query.limit) || 20, 1),
      MAX_REFERRAL_HISTORY_PAGE_SIZE
   );
   const rows = await prisma.referralEvent.findMany({
      where: {
         walletAddress: wallet,
         ...(cursor
            ? {
                 OR: [
                    { createdAt: { lt: new Date(cursor.createdAt) } },
                    {
                       createdAt: { equals: new Date(cursor.createdAt) },
                       id: { lt: cursor.id },
                    },
                 ],
              }
            : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
   });

   const hasMore = rows.length > limit;
   const page = rows.slice(0, limit);
   const last = page.at(-1);
   return {
      items: page.map((row) => ({
         id: row.id,
         keyId: row.keyId,
         amountXlm: Number(row.amount),
         txHash: row.txHash,
         eventIndex: row.eventIndex,
         refereeAddress: row.refereeAddress,
         timestamp: row.createdAt.toISOString(),
      })),
      nextCursor:
         hasMore && last
            ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
   };
}

function resolveReferralContractId(
   keyId: string,
   registeredKeys: Array<{ id: string; keyAddress: string }>
): string | null {
   if (/^C[A-Z2-7]{55}$/.test(keyId)) return keyId;
   return registeredKeys.find((key) => key.id === keyId)?.keyAddress ?? null;
}

async function findContractIdForKey(keyId: string): Promise<string> {
   const registeredKey = await prisma.registeredKey.findFirst({
      where: { OR: [{ id: keyId }, { keyAddress: keyId }] },
      select: { id: true, keyAddress: true },
   });
   const contractId =
      registeredKey?.keyAddress ?? (/^C[A-Z2-7]{55}$/.test(keyId) ? keyId : null);
   if (!contractId) throw new ReferralKeyNotFoundError(keyId);
   return contractId;
}

function networkPassphrase(): string {
   return envConfig.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}

async function getAccountSequence(wallet: string): Promise<string> {
   try {
      const response = await horizonGet(`/accounts/${encodeURIComponent(wallet)}`);
      if (!response.ok) {
         throw new ReferralContractUnavailableError(
            'Unable to load the referral wallet from Horizon'
         );
      }
      const account = (await response.json()) as { sequence?: unknown };
      if (typeof account.sequence !== 'string' || !/^\d+$/.test(account.sequence)) {
         throw new ReferralContractUnavailableError(
            'Horizon returned an invalid account sequence'
         );
      }
      return account.sequence;
   } catch (error) {
      if (error instanceof ReferralContractUnavailableError) throw error;
      throw new ReferralContractUnavailableError('Unable to load the referral wallet from Horizon');
   }
}

function buildReferralViewXdr(
   contractId: string,
   wallet: string,
   sequence: string
): string {
   const operation = new Contract(contractId).call(
      'get_referral_earnings',
      new Address(wallet).toScVal()
   );
   return new TransactionBuilder(new Account(wallet, sequence), {
      fee: '100',
      networkPassphrase: networkPassphrase(),
   })
      .addOperation(operation)
      .setTimeout(300)
      .build()
      .toXDR();
}

function decodeI128(scValXdr: string): bigint {
   const value = xdr.ScVal.fromXDR(scValXdr, 'base64');
   if (value.switch() !== xdr.ScValType.scvI128()) {
      throw new ReferralContractUnavailableError('Referral contract returned an invalid balance');
   }
   const parts = value.i128() as unknown as {
      hi(): { toString(): string };
      lo(): { toString(): string };
   };
   return (
      (BigInt(parts.hi().toString()) << 64n) |
      BigInt.asUintN(64, BigInt(parts.lo().toString()))
   );
}

export function formatStroops(stroops: bigint): number {
   const negative = stroops < 0n;
   const absolute = negative ? -stroops : stroops;
   const whole = absolute / STROOPS_PER_XLM;
   const fraction = absolute % STROOPS_PER_XLM;
   const amount = Number(`${whole}.${fraction.toString().padStart(7, '0')}`);
   return negative ? -amount : amount;
}

export async function getReferralContractEarnings(
   contractId: string,
   wallet: string,
   sequence?: string
): Promise<bigint> {
   const sourceSequence = sequence ?? (await getAccountSequence(wallet));
   try {
      const response = await fetch(envConfig.STELLAR_SOROBAN_RPC_URL, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'referral-earnings',
            method: 'simulateTransaction',
            params: {
               transaction: buildReferralViewXdr(contractId, wallet, sourceSequence),
            },
         }),
      });
      if (!response.ok) throw new ReferralContractUnavailableError();
      const envelope = (await response.json()) as {
         error?: { message?: string };
         result?: { results?: Array<{ xdr?: string; retval?: string }> };
      };
      if (envelope.error) throw new ReferralContractUnavailableError();
      const returnedXdr =
         envelope.result?.results?.[0]?.xdr ?? envelope.result?.results?.[0]?.retval;
      if (!returnedXdr) {
         throw new ReferralContractUnavailableError(
            'Referral contract returned no balance'
         );
      }
      return decodeI128(returnedXdr);
   } catch (error) {
      if (error instanceof ReferralContractUnavailableError) throw error;
      throw new ReferralContractUnavailableError();
   }
}

async function getReferralContractsForWallet(wallet: string): Promise<string[]> {
   const [events, referred] = await Promise.all([
      prisma.referralEvent.findMany({
         where: { walletAddress: wallet },
         distinct: ['keyId'],
         select: { keyId: true },
      }),
      prisma.referral.findMany({
         where: { referrerAddress: wallet, firstTradeKeyId: { not: null } },
         distinct: ['firstTradeKeyId'],
         select: { firstTradeKeyId: true },
      }),
   ]);
   const keyIds = [...new Set([
      ...events.map((row) => row.keyId),
      ...referred.map((row) => row.firstTradeKeyId).filter((id): id is string => Boolean(id)),
   ])];
   if (keyIds.length === 0) return [];

   const registeredKeys = await prisma.registeredKey.findMany({
      where: {
         OR: [
            { id: { in: keyIds } },
            { keyAddress: { in: keyIds } },
         ],
      },
      select: { id: true, keyAddress: true },
   });
   const contractIds = keyIds
      .map((keyId) => resolveReferralContractId(keyId, registeredKeys))
      .filter((id): id is string => Boolean(id));
   if (contractIds.length !== keyIds.length) {
      throw new ReferralContractUnavailableError(
         'A referral trade is missing its creator contract mapping'
      );
   }
   return [...new Set(contractIds)];
}

export async function getPendingReferralRewards(wallet: string): Promise<number> {
   const contractIds = await getReferralContractsForWallet(wallet);
   if (contractIds.length === 0) return 0;
   const sourceSequence = await getAccountSequence(wallet);
   const balances = await Promise.all(
      contractIds.map((contractId) =>
         getReferralContractEarnings(contractId, wallet, sourceSequence)
      )
   );
   const totalStroops = balances.reduce((total, balance) => total + balance, 0n);
   if (totalStroops < 0n) {
      throw new ReferralContractUnavailableError('Referral contract returned a negative balance');
   }
   return formatStroops(totalStroops);
}

export interface ReferralClaimTransaction {
   transaction: string;
   transactionXdr: string;
   unsignedTransaction: string;
   networkPassphrase: string;
   keyId: string;
   contractId: string;
   claimantWallet: string;
   pendingAmount: number;
}

export async function buildReferralClaimTransaction(input: {
   wallet: string;
   keyId: string;
}): Promise<ReferralClaimTransaction> {
   const contractId = await findContractIdForKey(input.keyId);
   const sourceSequence = await getAccountSequence(input.wallet);
   const pendingAmount = formatStroops(
      await getReferralContractEarnings(contractId, input.wallet, sourceSequence)
   );
   if (pendingAmount <= 0) throw new NothingToClaimError();

   return createReferralClaimTransaction({
      wallet: input.wallet,
      keyId: input.keyId,
      contractId,
      pendingAmount,
      sourceSequence,
   });
}

export function createReferralClaimTransaction(input: {
   wallet: string;
   keyId: string;
   contractId: string;
   pendingAmount: number;
   sourceSequence?: string;
}): ReferralClaimTransaction {

   const operation = new Contract(input.contractId).call(
      'claim_referral_rewards',
      new Address(input.wallet).toScVal()
   );
   const passphrase = networkPassphrase();
   const unsigned = new TransactionBuilder(
      new Account(input.wallet, input.sourceSequence ?? '0'),
      {
      fee: '100',
      networkPassphrase: passphrase,
      }
   )
      .addOperation(operation)
      .setTimeout(300)
      .build()
      .toXDR();
   return {
      transaction: unsigned,
      transactionXdr: unsigned,
      unsignedTransaction: unsigned,
      networkPassphrase: passphrase,
      keyId: input.keyId,
      contractId: input.contractId,
      claimantWallet: input.wallet,
      pendingAmount: input.pendingAmount,
   };
}
