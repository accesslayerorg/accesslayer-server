export type SorobanWALOperation = 'BUY' | 'SELL';
export type SorobanWALState =
   | 'PENDING'
   | 'SUBMITTED'
   | 'CONFIRMED'
   | 'FAILED'
   | 'ROLLED_BACK';

export interface SorobanWALEntry {
   id: string;
   idempotencyKey: string;
   operation: SorobanWALOperation;
   wallet: string;
   creatorWallet: string;
   amount: string;
   expectedSupplyBefore: string;
   xdrPayload: string;
   state: SorobanWALState;
   txHash: string | null;
   submittedAt: Date | null;
   confirmedAt: Date | null;
   error: string | null;
   createdAt: Date;
   updatedAt: Date;
}

export interface CreateSorobanWALEntry {
   idempotencyKey: string;
   operation: SorobanWALOperation;
   wallet: string;
   creatorWallet: string;
   amount: string;
   expectedSupplyBefore: string;
   xdrPayload: string;
}

export type DatabaseTransaction = unknown;
export type ValidateSorobanOperation = (
   transaction: DatabaseTransaction
) => Promise<void>;
export type ApplySorobanSideEffects = (
   transaction: DatabaseTransaction,
   entry: SorobanWALEntry
) => Promise<void>;
export type RollbackSorobanOptimisticState = ApplySorobanSideEffects;

export interface SorobanWALStore {
   createPending(
      input: CreateSorobanWALEntry,
      validate: ValidateSorobanOperation
   ): Promise<{ entry: SorobanWALEntry; created: boolean }>;
   markSubmitted(id: string, txHash: string): Promise<SorobanWALEntry>;
   markFailed(
      id: string,
      error: string,
      rollback: RollbackSorobanOptimisticState
   ): Promise<SorobanWALEntry>;
   markRolledBack(
      id: string,
      rollback: RollbackSorobanOptimisticState
   ): Promise<SorobanWALEntry>;
   confirmAtomically(
      id: string,
      txHash: string,
      applySideEffects: ApplySorobanSideEffects
   ): Promise<SorobanWALEntry>;
   listRecoverable(olderThan: Date): Promise<SorobanWALEntry[]>;
}

export type SorobanTransactionStatus =
   | { status: 'PENDING' }
   | { status: 'CONFIRMED' }
   | { status: 'FAILED'; error: string };

export interface SorobanTransactionGateway {
   submit(xdrPayload: string): Promise<{ txHash: string }>;
   getStatus(txHash: string): Promise<SorobanTransactionStatus>;
}
