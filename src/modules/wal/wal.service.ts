import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   CreateWALEntryInput,
   ExecuteBuySellResult,
   ISorobanClient,
   SorobanOperationType,
} from './wal.types';
import { defaultSorobanClient } from './soroban-client';

export class SorobanWALService {
   constructor(
      private prisma: PrismaClient = defaultPrisma,
      private sorobanClient: ISorobanClient = defaultSorobanClient
   ) {}

   /**
    * Helper to normalize operation to uppercase BUY | SELL.
    */
   private normalizeOperation(op: string): SorobanOperationType {
      const upper = op.toUpperCase();
      if (upper !== 'BUY' && upper !== 'SELL') {
         throw new Error(
            `Invalid Soroban operation: "${op}". Must be "buy" or "sell".`
         );
      }
      return upper as SorobanOperationType;
   }

   /**
    * Calculates a bonding curve spot price for a creator's keys given supply.
    * Standard polynomial bonding curve: Price = (supply^2) / 1600 + 0.001
    */
   public calculatePrice(supply: number | Prisma.Decimal): Prisma.Decimal {
      const s = Number(supply);
      const calculated = (s * s) / 1600 + 0.001;
      return new Prisma.Decimal(calculated.toFixed(6));
   }

   /**
    * Step 1: Write the WAL entry with state PENDING inside the same database transaction
    * that validates the request — before any Soroban call is made.
    * Only proceed to Soroban submission after the WAL entry is durably written.
    */
   async createPendingWALEntry(
      input: CreateWALEntryInput,
      externalTx?: Prisma.TransactionClient
   ): Promise<{
      entry: any;
      isIdempotentReplay: boolean;
      alreadyConfirmed: boolean;
   }> {
      const operation = this.normalizeOperation(input.operation);
      const amountDecimal = new Prisma.Decimal(input.amount.toString());
      const expectedSupplyDecimal = new Prisma.Decimal(
         input.expectedSupplyBefore.toString()
      );

      if (amountDecimal.lte(0)) {
         throw new Error('Transaction amount must be greater than 0');
      }

      if (!input.wallet || !input.wallet.trim()) {
         throw new Error('Wallet address is required');
      }

      if (!input.creatorWallet || !input.creatorWallet.trim()) {
         throw new Error('Creator wallet address is required');
      }

      if (!input.xdrPayload || !input.xdrPayload.trim()) {
         throw new Error('Soroban XDR payload is required');
      }

      const runInTransaction = async (tx: Prisma.TransactionClient) => {
         // Idempotency check if idempotencyKey is supplied
         if (input.idempotencyKey) {
            const existing = await tx.sorobanWALEntry.findUnique({
               where: { idempotencyKey: input.idempotencyKey },
            });

            if (existing) {
               logger.info(
                  {
                     idempotencyKey: input.idempotencyKey,
                     state: existing.state,
                     entryId: existing.id,
                  },
                  'Idempotency key hit for Soroban WAL entry'
               );

               return {
                  entry: existing,
                  isIdempotentReplay: true,
                  alreadyConfirmed: existing.state === 'CONFIRMED',
               };
            }
         }

         // If SELL operation: validate caller's current balance before creating WAL entry
         if (operation === 'SELL') {
            const currentOwnership = await tx.keyOwnership.findUnique({
               where: {
                  ownerAddress_creatorId: {
                     ownerAddress: input.wallet,
                     creatorId: input.creatorWallet,
                  },
               },
            });

            const currentBalance = currentOwnership
               ? new Prisma.Decimal(currentOwnership.balance)
               : new Prisma.Decimal(0);
            if (currentBalance.lt(amountDecimal)) {
               throw new Error(
                  `Insufficient key balance to execute sell. Owned: ${currentBalance.toString()}, requested: ${amountDecimal.toString()}`
               );
            }
         }

         // Durably write WAL entry with PENDING state
         const entry = await tx.sorobanWALEntry.create({
            data: {
               operation,
               wallet: input.wallet,
               creatorWallet: input.creatorWallet,
               amount: amountDecimal,
               expectedSupplyBefore: expectedSupplyDecimal,
               xdrPayload: input.xdrPayload,
               state: 'PENDING',
               idempotencyKey: input.idempotencyKey || null,
            },
         });

         logger.info(
            {
               entryId: entry.id,
               operation,
               wallet: input.wallet,
               creatorWallet: input.creatorWallet,
            },
            'Durable WAL entry created in PENDING state'
         );

         return {
            entry,
            isIdempotentReplay: false,
            alreadyConfirmed: false,
         };
      };

      if (externalTx) {
         return runInTransaction(externalTx);
      } else {
         return this.prisma.$transaction(runInTransaction);
      }
   }

   /**
    * Applies all database side effects for a confirmed Soroban transaction.
    *
    * Idempotency Guard:
    * Checks whether a WAL entry for that txHash has already been applied — if so skips.
    * Applies all side effects in a single database transaction with the WAL state update
    * to CONFIRMED as the LAST operation so a crash during side-effect application results
    * in a re-applied confirmation on next recovery.
    */
   async applyConfirmedSideEffects(
      txHash: string,
      externalTx?: Prisma.TransactionClient
   ): Promise<{ applied: boolean; entry: any }> {
      const execute = async (tx: Prisma.TransactionClient) => {
         const entry = await tx.sorobanWALEntry.findUnique({
            where: { txHash },
         });

         if (!entry) {
            throw new Error(
               `Cannot apply side effects: WAL entry for txHash ${txHash} not found`
            );
         }

         // Idempotency Guard: If already marked CONFIRMED, side effects were already applied
         if (entry.state === 'CONFIRMED') {
            logger.info(
               {
                  txHash,
                  entryId: entry.id,
               },
               'Idempotency guard: transaction side effects already applied'
            );
            return { applied: false, entry };
         }

         const amount = new Prisma.Decimal(entry.amount);
         const isBuy = entry.operation === 'BUY';

         // 1. Balance update
         const balanceChange = isBuy ? amount : amount.negated();
         await tx.keyOwnership.upsert({
            where: {
               ownerAddress_creatorId: {
                  ownerAddress: entry.wallet,
                  creatorId: entry.creatorWallet,
               },
            },
            create: {
               ownerAddress: entry.wallet,
               creatorId: entry.creatorWallet,
               balance: isBuy ? amount : new Prisma.Decimal(0),
            },
            update: {
               balance: {
                  increment: balanceChange,
               },
            },
         });

         // 2. Holder count and Supply updates
         const activeHoldersCount = await tx.keyOwnership.count({
            where: {
               creatorId: entry.creatorWallet,
               balance: { gt: 0 },
            },
         });

         const currentStats = await tx.creatorStats.findUnique({
            where: { creatorId: entry.creatorWallet },
         });

         const previousSupply = currentStats
            ? new Prisma.Decimal(currentStats.totalSupply)
            : new Prisma.Decimal(entry.expectedSupplyBefore);
         const newSupply = isBuy
            ? previousSupply.add(amount)
            : previousSupply.sub(amount);
         const price = this.calculatePrice(newSupply);
         const volumeDelta = price.mul(amount);

         await tx.creatorStats.upsert({
            where: { creatorId: entry.creatorWallet },
            create: {
               creatorId: entry.creatorWallet,
               holderCount: activeHoldersCount,
               totalSupply: newSupply,
               totalVolume: volumeDelta,
            },
            update: {
               holderCount: activeHoldersCount,
               totalSupply: newSupply,
               totalVolume: {
                  increment: volumeDelta,
               },
            },
         });

         // 3. Price snapshot
         await tx.priceSnapshot.create({
            data: {
               creatorId: entry.creatorWallet,
               price,
               supply: newSupply,
               timestamp: new Date(),
            },
         });

         // 4. Transaction history & Activity log
         await tx.transactionHistory.upsert({
            where: { txHash },
            create: {
               txHash,
               walEntryId: entry.id,
               operation: entry.operation,
               wallet: entry.wallet,
               creatorWallet: entry.creatorWallet,
               amount,
               price,
            },
            update: {},
         });

         await tx.activity.create({
            data: {
               type: isBuy ? 'KEY_BOUGHT' : 'KEY_SOLD',
               actor: entry.wallet,
               creatorId: entry.creatorWallet,
               target: entry.creatorWallet,
               payload: {
                  txHash,
                  amount: amount.toString(),
                  price: price.toString(),
                  operation: entry.operation,
               },
            },
         });

         // LAST OPERATION IN TRANSACTION: Update WAL state to CONFIRMED
         const confirmedEntry = await tx.sorobanWALEntry.update({
            where: { id: entry.id },
            data: {
               state: 'CONFIRMED',
               confirmedAt: new Date(),
            },
         });

         logger.info(
            {
               entryId: entry.id,
               txHash,
               activeHoldersCount,
               newSupply: newSupply.toString(),
               price: price.toString(),
            },
            'Atomically applied side effects and updated WAL to CONFIRMED'
         );

         return { applied: true, entry: confirmedEntry };
      };

      if (externalTx) {
         return execute(externalTx);
      } else {
         return this.prisma.$transaction(execute);
      }
   }

   /**
    * Polls Horizon until the transaction settles, fails, or exhausts retries.
    */
   async pollHorizonForConfirmation(
      txHash: string,
      maxPollAttempts = 10,
      baseBackoffMs = 100
   ): Promise<{ status: 'SUCCESS' | 'FAILED' | 'PENDING'; error?: string }> {
      for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
         const result = await this.sorobanClient.getTransactionResult(txHash);

         if (result.status === 'SUCCESS' || result.status === 'FAILED') {
            return result;
         }

         // Exponential backoff before next poll
         if (attempt < maxPollAttempts) {
            const delay = baseBackoffMs * Math.pow(2, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, delay));
         }
      }

      return { status: 'PENDING' };
   }

   /**
    * Executes the full buy/sell flow:
    * 1. Validates request & writes WAL PENDING entry in atomic DB transaction
    * 2. Submits to Soroban & updates WAL to SUBMITTED with txHash
    * 3. Polls Horizon for confirmation
    * 4. Applies all side effects + updates WAL to CONFIRMED atomically
    * 5. On failure, marks WAL as FAILED and rolls back optimistic state
    */
   async executeBuySellFlow(
      input: CreateWALEntryInput,
      options?: {
         client?: ISorobanClient;
         maxPollAttempts?: number;
         baseBackoffMs?: number;
         simulateCrashAfterPending?: boolean;
         simulateCrashAfterSubmitted?: boolean;
      }
   ): Promise<ExecuteBuySellResult> {
      const client = options?.client || this.sorobanClient;

      // 1. Create WAL entry in PENDING state inside same DB tx that validates request
      const { entry, isIdempotentReplay, alreadyConfirmed } =
         await this.createPendingWALEntry(input);

      if (isIdempotentReplay && alreadyConfirmed) {
         return {
            walEntryId: entry.id,
            txHash: entry.txHash,
            state: 'CONFIRMED',
            confirmed: true,
            isIdempotentReplay: true,
         };
      }

      // Testing simulation hook: Simulate server crash between WAL PENDING write and Soroban submission
      if (options?.simulateCrashAfterPending) {
         logger.warn('Simulating crash after durable WAL PENDING write');
         throw new Error('Simulated server crash after WAL PENDING write');
      }

      // 2. Submit Soroban transaction
      let txHash: string;
      try {
         const submissionResult = await client.submitTransaction(
            entry.xdrPayload
         );
         txHash = submissionResult.txHash;

         // Update WAL entry to SUBMITTED with txHash
         await this.prisma.sorobanWALEntry.update({
            where: { id: entry.id },
            data: {
               state: 'SUBMITTED',
               txHash,
               submittedAt: new Date(),
            },
         });
      } catch (submitError: any) {
         // Submission failure: mark WAL as FAILED and roll back any optimistic state
         const errMsg = submitError.message || 'Soroban submission failed';
         await this.prisma.sorobanWALEntry.update({
            where: { id: entry.id },
            data: {
               state: 'FAILED',
               error: errMsg,
            },
         });

         logger.error(
            {
               entryId: entry.id,
               error: errMsg,
            },
            'Soroban submission failed, marked WAL entry FAILED'
         );

         return {
            walEntryId: entry.id,
            txHash: null,
            state: 'FAILED',
            confirmed: false,
            error: errMsg,
         };
      }

      // Testing simulation hook: Simulate server crash between SUBMITTED and CONFIRMED DB write
      if (options?.simulateCrashAfterSubmitted) {
         logger.warn(
            'Simulating crash after Soroban submission before database confirmation write'
         );
         throw new Error(
            'Simulated server crash between SUBMITTED and CONFIRMED'
         );
      }

      // 3. Poll Horizon for confirmation
      const pollResult = await this.pollHorizonForConfirmation(
         txHash,
         options?.maxPollAttempts ?? 10,
         options?.baseBackoffMs ?? 100
      );

      if (pollResult.status === 'SUCCESS') {
         // 4. Atomically apply side effects and update WAL entry to CONFIRMED
         await this.applyConfirmedSideEffects(txHash);

         return {
            walEntryId: entry.id,
            txHash,
            state: 'CONFIRMED',
            confirmed: true,
         };
      } else if (pollResult.status === 'FAILED') {
         const errMsg = pollResult.error || 'Transaction rejected by Horizon';
         await this.prisma.sorobanWALEntry.update({
            where: { id: entry.id },
            data: {
               state: 'FAILED',
               error: errMsg,
            },
         });

         return {
            walEntryId: entry.id,
            txHash,
            state: 'FAILED',
            confirmed: false,
            error: errMsg,
         };
      } else {
         // Still pending after polling attempts - recovery worker will resolve it
         return {
            walEntryId: entry.id,
            txHash,
            state: 'SUBMITTED',
            confirmed: false,
         };
      }
   }
}

export const sorobanWALService = new SorobanWALService();
