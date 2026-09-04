import {
   ApplySorobanSideEffects,
   CreateSorobanWALEntry,
   RollbackSorobanOptimisticState,
   SorobanTransactionGateway,
   SorobanWALEntry,
   SorobanWALStore,
   ValidateSorobanOperation,
} from './soroban-wal.types';

const noValidation: ValidateSorobanOperation = async () => {};
const noRollback: RollbackSorobanOptimisticState = async () => {};

export interface SorobanWALServiceOptions {
   maxConfirmationAttempts?: number;
   baseRetryDelayMs?: number;
   sleep?: (milliseconds: number) => Promise<void>;
}

export interface ExecuteSorobanOperation extends CreateSorobanWALEntry {
   validate?: ValidateSorobanOperation;
   applySideEffects: ApplySorobanSideEffects;
   rollbackOptimisticState?: RollbackSorobanOptimisticState;
}

export class SorobanWALService {
   private readonly maxConfirmationAttempts: number;
   private readonly baseRetryDelayMs: number;
   private readonly sleep: (milliseconds: number) => Promise<void>;

   constructor(
      private readonly store: SorobanWALStore,
      private readonly gateway: SorobanTransactionGateway,
      options: SorobanWALServiceOptions = {}
   ) {
      this.maxConfirmationAttempts = options.maxConfirmationAttempts ?? 10;
      this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1000;
      this.sleep =
         options.sleep ??
         (milliseconds =>
            new Promise(resolve => setTimeout(resolve, milliseconds)));
   }

   async execute(input: ExecuteSorobanOperation): Promise<SorobanWALEntry> {
      const { entry, created } = await this.store.createPending(
         input,
         input.validate ?? noValidation
      );

      if (!created) {
         if (entry.state === 'SUBMITTED' && entry.txHash) {
            return this.settleSubmitted(
               entry,
               input.applySideEffects,
               input.rollbackOptimisticState ?? noRollback
            );
         }
         return entry;
      }

      let submitted: SorobanWALEntry;
      try {
         const { txHash } = await this.gateway.submit(entry.xdrPayload);
         submitted = await this.store.markSubmitted(entry.id, txHash);
      } catch (error) {
         return this.store.markFailed(
            entry.id,
            getErrorMessage(error),
            input.rollbackOptimisticState ?? noRollback
         );
      }

      return this.settleSubmitted(
         submitted,
         input.applySideEffects,
         input.rollbackOptimisticState ?? noRollback
      );
   }

   async recover(
      olderThan: Date,
      applySideEffects: ApplySorobanSideEffects,
      rollbackOptimisticState: RollbackSorobanOptimisticState = noRollback
   ): Promise<SorobanWALEntry[]> {
      const entries = await this.store.listRecoverable(olderThan);
      const recovered: SorobanWALEntry[] = [];

      for (const entry of entries) {
         if (entry.state === 'PENDING') {
            recovered.push(
               await this.store.markRolledBack(
                  entry.id,
                  rollbackOptimisticState
               )
            );
            continue;
         }

         if (entry.state === 'SUBMITTED' && entry.txHash) {
            recovered.push(
               await this.settleSubmitted(
                  entry,
                  applySideEffects,
                  rollbackOptimisticState
               )
            );
         }
      }

      return recovered;
   }

   private async settleSubmitted(
      entry: SorobanWALEntry,
      applySideEffects: ApplySorobanSideEffects,
      rollbackOptimisticState: RollbackSorobanOptimisticState
   ): Promise<SorobanWALEntry> {
      const txHash = entry.txHash;
      if (!txHash) {
         return this.store.markFailed(
            entry.id,
            'SUBMITTED WAL entry is missing its transaction hash',
            rollbackOptimisticState
         );
      }

      for (let attempt = 0; attempt < this.maxConfirmationAttempts; attempt++) {
         const result = await this.gateway.getStatus(txHash);
         if (result.status === 'CONFIRMED') {
            return this.store.confirmAtomically(
               entry.id,
               txHash,
               applySideEffects
            );
         }
         if (result.status === 'FAILED') {
            return this.store.markFailed(
               entry.id,
               result.error,
               rollbackOptimisticState
            );
         }

         if (attempt + 1 < this.maxConfirmationAttempts) {
            await this.sleep(this.baseRetryDelayMs * 2 ** attempt);
         }
      }

      return this.store.markFailed(
         entry.id,
         `Transaction ${txHash} was still pending after ${this.maxConfirmationAttempts} checks`,
         rollbackOptimisticState
      );
   }
}

function getErrorMessage(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
}
