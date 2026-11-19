import {
   Address,
   TransactionBuilder,
   scValToNative,
   xdr,
} from '@stellar/stellar-base';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { envConfig } from '../../config';
import { prisma } from '../../utils/prisma.utils';
import {
   assertInvoiceTransferAllowed,
   invoiceNetwork,
   InvoiceProtocolUnavailableError,
   TransferBlockedError,
} from './invoice-protocol.contract';
import { requireInvoice } from './invoice-protocol.service';
import type { SubmitContractCallInput } from '../contracts/contract.types';
import { ContractSubmitError } from '../contracts/contract-error.utils';

export class InvalidInvoiceTransactionError extends Error {}

const argumentIndex = z.number().int().nonnegative().max(31);
const abiSchema = z
   .object({
      function: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/),
      from: argumentIndex,
      to: argumentIndex,
      invoice: argumentIndex,
      limitPrice: argumentIndex.optional(),
   })
   .strict()
   .refine(value => {
      const indexes = [
         value.from,
         value.to,
         value.invoice,
         value.limitPrice,
      ].filter(v => v !== undefined);
      return new Set(indexes).size === indexes.length;
   }, 'Argument indexes must be distinct');

function marketAbi() {
   try {
      if (
         !envConfig.INVOICE_MARKET_CONTRACT_ID ||
         !envConfig.INVOICE_MARKET_ABI
      )
         throw new Error();
      return abiSchema.parse(JSON.parse(envConfig.INVOICE_MARKET_ABI));
   } catch (_error) {
      throw new InvoiceProtocolUnavailableError(
         'Invoice market ABI is not configured'
      );
   }
}

function decodeEnvelope(transactionXdr: string) {
   try {
      const envelope = TransactionBuilder.fromXDR(
         transactionXdr,
         invoiceNetwork()
      );
      const transaction =
         'innerTransaction' in envelope ? envelope.innerTransaction : envelope;
      return { envelope, transaction };
   } catch (_error) {
      throw new InvalidInvoiceTransactionError(
         'Invalid signed transaction XDR'
      );
   }
}

function unsignedId(value: xdr.ScVal | undefined): string {
   if (!value || value.switch().name !== 'scvU64')
      throw new InvalidInvoiceTransactionError(
         'Invoice ID must be a signed u64 argument'
      );
   return value.u64().toString();
}

/** Decode only immutable XDR; request metadata cannot select the checked pair. */
export function inspectInvoicePurchase(transactionXdr: string, buyer: string) {
   const abi = marketAbi();
   const { envelope, transaction } = decodeEnvelope(transactionXdr);
   if (
      transaction.operations.length !== 1 ||
      transaction.source !== buyer ||
      !transaction.signatures.length
   ) {
      throw new InvalidInvoiceTransactionError(
         'Purchase must be a signed, single-operation transaction sourced by the buyer'
      );
   }
   const operation = transaction.operations[0];
   if (
      operation.type !== 'invokeHostFunction' ||
      operation.func.switch().name !== 'hostFunctionTypeInvokeContract' ||
      (operation.source && operation.source !== buyer)
   )
      throw new InvalidInvoiceTransactionError(
         'Expected invoice contract invocation'
      );
   const invocation = operation.func.invokeContract();
   if (
      Address.fromScAddress(invocation.contractAddress()).toString() !==
         envConfig.INVOICE_MARKET_CONTRACT_ID ||
      invocation.functionName().toString() !== abi.function
   )
      throw new InvalidInvoiceTransactionError(
         'Transaction does not call the configured invoice purchase function'
      );
   const args = invocation.args();
   let from: string;
   let to: string;
   try {
      from = Address.fromScVal(args[abi.from]).toString();
      to = Address.fromScVal(args[abi.to]).toString();
   } catch (_error) {
      throw new InvalidInvoiceTransactionError(
         'Invalid signed wallet arguments'
      );
   }
   if (to !== buyer)
      throw new InvalidInvoiceTransactionError(
         'Signed recipient does not match the buyer'
      );
   const invoiceId = unsignedId(args[abi.invoice]);
   let limitPrice: string | null = null;
   if (abi.limitPrice !== undefined) {
      const value = args[abi.limitPrice];
      if (
         !value ||
         !['scvI128', 'scvU128', 'scvU64', 'scvI64'].includes(
            value.switch().name
         )
      ) {
         throw new InvalidInvoiceTransactionError(
            'Limit price must be an integer in the signed envelope'
         );
      }
      limitPrice = String(scValToNative(value));
      if (BigInt(limitPrice) <= 0n)
         throw new InvalidInvoiceTransactionError(
            'Limit price must be positive'
         );
   }
   return {
      from,
      to,
      invoiceId,
      limitPrice,
      txHash: envelope.hash().toString('hex'),
   };
}

/** The shared submission service calls this even when operation metadata lies. */
export async function guardInvoiceMarketSubmission(
   input: SubmitContractCallInput
): Promise<void> {
   if (!envConfig.INVOICE_MARKET_CONTRACT_ID) return;
   const { transaction } = decodeEnvelope(input.transactionXdr);
   const touchesMarket = transaction.operations.some(
      operation =>
         operation.type === 'invokeHostFunction' &&
         operation.func.switch().name === 'hostFunctionTypeInvokeContract' &&
         Address.fromScAddress(
            operation.func.invokeContract().contractAddress()
         ).toString() === envConfig.INVOICE_MARKET_CONTRACT_ID
   );
   if (!touchesMarket) return;
   // Unknown calls on the configured market fail closed rather than allowing
   // an unrecognized purchase variant to bypass the restriction check.
   const purchase = inspectInvoicePurchase(
      input.transactionXdr,
      input.submitterWallet
   );
   await assertInvoiceTransferAllowed(
      purchase.from,
      purchase.to,
      purchase.invoiceId
   );
}

async function validateInvoicePurchase(
   invoiceId: string,
   buyer: string,
   transactionXdr: string
) {
   const purchase = inspectInvoicePurchase(transactionXdr, buyer);
   const invoice = await requireInvoice(invoiceId);
   if (
      purchase.invoiceId !== invoiceId ||
      purchase.from !== invoice.sellerWallet
   ) {
      throw new InvalidInvoiceTransactionError(
         'Signed purchase does not match this invoice and seller'
      );
   }
   return purchase;
}

export async function buyInvoice(
   invoiceId: string,
   buyer: string,
   transactionXdr: string
) {
   await validateInvoicePurchase(invoiceId, buyer, transactionXdr);
   const { submitContractCall } = await import('../contracts/contract.service');
   return submitContractCall(
      { operation: 'buy', submitterWallet: buyer, transactionXdr },
      {}
   );
}

export async function placeInvoiceLimitOrder(
   invoiceId: string,
   buyer: string,
   transactionXdr: string
) {
   const purchase = await validateInvoicePurchase(
      invoiceId,
      buyer,
      transactionXdr
   );
   if (!purchase.limitPrice)
      throw new InvalidInvoiceTransactionError(
         'Limit orders require a configured signed price-limit argument'
      );
   const row = await prisma.invoiceLimitOrder.upsert({
      where: { txHash: purchase.txHash },
      update: {},
      create: {
         invoiceId,
         buyerWallet: buyer,
         fromWallet: purchase.from,
         limitPrice: purchase.limitPrice,
         transactionXdr,
         txHash: purchase.txHash,
      },
   });
   return {
      order_id: row.id,
      invoice_id: row.invoiceId,
      limit_price: row.limitPrice,
      status: row.status,
   };
}

/**
 * Match pre-authorized signed purchase envelopes. The deployed purchase
 * function MUST enforce its signed price bound; the server cannot change it.
 * A lease prevents parallel API/worker calls from submitting a row twice.
 * Interrupted leases retry the same transaction hash, never a rebuilt trade.
 */
export async function matchInvoiceLimitOrders(
   invoiceId: string,
   buyer: string
) {
   const invoice = await requireInvoice(invoiceId);
   const now = new Date();
   const results: {
      order_id: string;
      status: string;
      reason?: string;
      restriction_type?: string;
   }[] = [];
   let cursor: string | undefined;
   do {
      const rows = await prisma.invoiceLimitOrder.findMany({
         where: {
            invoiceId,
            createdAt: { lte: now },
            ...(invoice.sellerWallet === buyer ? {} : { buyerWallet: buyer }),
            OR: [
               { status: 'PENDING' },
               { status: 'SUBMITTING', leaseUntil: { lt: now } },
            ],
         },
         orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
         take: 100,
         ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      cursor = rows.length === 100 ? rows[rows.length - 1].id : undefined;
      for (const row of rows) {
         const token = randomUUID();
         const claimed = await prisma.invoiceLimitOrder.updateMany({
            where: {
               id: row.id,
               OR: [
                  { status: 'PENDING' },
                  { status: 'SUBMITTING', leaseUntil: { lt: now } },
               ],
            },
            data: {
               status: 'SUBMITTING',
               leaseToken: token,
               leaseUntil: new Date(
                  Date.now() +
                     envConfig.SOROBAN_POLL_TIMEOUT_MS +
                     envConfig.SOROBAN_SUBMIT_MAX_ATTEMPTS *
                        (envConfig.DB_QUERY_TIMEOUT_MS +
                           envConfig.SOROBAN_SUBMIT_MAX_DELAY_MS) +
                     60000
               ),
            },
         });
         if (!claimed.count) continue;
         const release = (status: string) =>
            prisma.invoiceLimitOrder.updateMany({
               where: { id: row.id, leaseToken: token },
               data: { status, leaseToken: null, leaseUntil: null },
            });
         try {
            const result = await buyInvoice(
               invoiceId,
               row.buyerWallet,
               row.transactionXdr
            );
            // A transient/unconfirmed outcome can be retried safely with the same
            // immutable envelope. Confirmed on-chain failures are terminal.
            const status =
               result.status === 'CONFIRMED'
                  ? 'FILLED'
                  : result.errorKind === 'transient'
                    ? 'PENDING'
                    : 'FAILED';
            await release(status);
            results.push({ order_id: row.id, status });
         } catch (error) {
            const terminal =
               error instanceof InvalidInvoiceTransactionError ||
               (error instanceof ContractSubmitError && error.kind === 'user');
            await release(terminal ? 'FAILED' : 'PENDING');
            if (terminal) {
               results.push({ order_id: row.id, status: 'FAILED' });
               continue;
            }
            if (error instanceof TransferBlockedError) {
               results.push({
                  order_id: row.id,
                  status: 'SKIPPED',
                  reason: error.reason,
                  restriction_type: error.restrictionType,
               });
               continue;
            }
            throw error;
         }
      }
   } while (cursor);
   return results;
}
