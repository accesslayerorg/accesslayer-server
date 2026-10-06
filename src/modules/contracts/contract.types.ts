// src/modules/contracts/contract.types.ts
// Shared types for the centralised Soroban contract interaction service (#899).

/**
 * Logical on-chain operations routed through the service layer.
 * Every contract call the server submits must declare one of these so
 * transactions can be tracked and audited per operation kind.
 */
export type ContractOperation =
   | 'buy'
   | 'sell'
   | 'stake'
   | 'governance'
   | 'claim';

export const CONTRACT_OPERATIONS: ContractOperation[] = [
   'buy',
   'sell',
   'stake',
   'governance',
   'claim',
];

export function isContractOperation(value: string): value is ContractOperation {
   return CONTRACT_OPERATIONS.includes(value as ContractOperation);
}

/** Lifecycle status of a submitted transaction. */
export type ContractTransactionStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';

/** Error classification returned alongside every failed submission. */
export type ContractErrorKind = 'user' | 'transient';

/** Input accepted by `submitContractCall`. */
export interface SubmitContractCallInput {
   /** Logical operation being performed (used for tracking and events). */
   operation: ContractOperation;
   /** Wallet that requested the submission (tracking + audit context). */
   submitterWallet: string;
   /** Base64 XDR of the fully signed transaction envelope to submit. */
   transactionXdr: string;
}

/** Terminal resolution of a submission: either confirmed or failed. */
export type ContractSubmissionResult =
   | {
        status: 'CONFIRMED';
        txHash: string;
        ledger: number;
        resultXdr?: string;
        attempts: number;
     }
   | {
        status: 'FAILED';
        txHash: string | null;
        errorKind: ContractErrorKind;
        lastError: string;
        attempts: number;
     };

/** Payload carried by `contract_tx_confirmed` events. */
export interface ContractTxConfirmedEvent {
   operation: ContractOperation;
   submitterWallet: string;
   txHash: string;
   ledger: number;
   resultXdr?: string;
   attempts: number;
}

/** Payload carried by `contract_tx_failed` events. */
export interface ContractTxFailedEvent {
   operation: ContractOperation;
   submitterWallet: string;
   txHash: string | null;
   errorKind: ContractErrorKind;
   lastError: string;
   attempts: number;
}

export type ContractServiceEvent =
   | ({ type: 'contract_tx_confirmed' } & ContractTxConfirmedEvent)
   | ({ type: 'contract_tx_failed' } & ContractTxFailedEvent);
