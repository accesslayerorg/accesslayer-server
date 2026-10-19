// src/modules/nonce/nonce.types.ts
// Shared types for nonce management and replay protection (#1039).

export interface NonceInfo {
   wallet: string;
   nonce: number;
   cached: boolean;
}

export interface ConsumeNonceResult {
   wallet: string;
   consumedNonce: number;
   nextNonce: number;
}

export interface ConsumedNonceRecord {
   wallet: string;
   nonce: number;
   action?: string;
   consumedAt: string;
}

/**
 * Pluggable provider for querying wallet nonces from an on-chain contract.
 * Injectable in tests and services.
 */
export interface NonceContractProvider {
   getWalletNonce(wallet: string): Promise<number>;
}
