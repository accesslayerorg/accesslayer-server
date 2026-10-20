import { Decimal } from '@prisma/client/runtime/library';

export type SorobanOperationType = 'BUY' | 'SELL';
export type SorobanOperationInput = 'BUY' | 'SELL' | 'buy' | 'sell';

export type SorobanWALStateType =
   | 'PENDING'
   | 'SUBMITTED'
   | 'CONFIRMED'
   | 'FAILED'
   | 'ROLLED_BACK';

export interface SorobanWALEntryRecord {
   id: string;
   operation: SorobanOperationType;
   wallet: string;
   creatorWallet: string;
   amount: Decimal | number | string;
   expectedSupplyBefore: Decimal | number | string;
   xdrPayload: string;
   state: SorobanWALStateType;
   txHash: string | null;
   idempotencyKey: string | null;
   submittedAt: Date | null;
   confirmedAt: Date | null;
   error: string | null;
   createdAt: Date;
   updatedAt: Date;
}

export interface CreateWALEntryInput {
   operation: SorobanOperationInput;
   wallet: string;
   creatorWallet: string;
   amount: number | string | Decimal;
   expectedSupplyBefore: number | string | Decimal;
   xdrPayload: string;
   idempotencyKey?: string;
}

export interface HorizonTxResult {
   status: 'SUCCESS' | 'FAILED' | 'PENDING';
   error?: string;
   ledger?: number;
}

export interface ISorobanClient {
   submitTransaction(xdrPayload: string): Promise<{ txHash: string }>;
   getTransactionResult(txHash: string): Promise<HorizonTxResult>;
}

export interface RecoveryWorkerOptions {
   ageThresholdMs?: number; // default 30000 (30 seconds)
   maxPollAttempts?: number; // default 10
   baseBackoffMs?: number; // default 100
}

export interface RecoverySummary {
   scannedCount: number;
   rolledBackCount: number;
   confirmedCount: number;
   failedCount: number;
   stillPendingCount: number;
   skippedIdempotentCount: number;
}

export interface ExecuteBuySellResult {
   walEntryId: string;
   txHash: string | null;
   state: SorobanWALStateType;
   confirmed: boolean;
   error?: string;
   isIdempotentReplay?: boolean;
}
