// src/modules/relay/relay.types.ts
// Shared types for the gasless meta-transaction relay flow (#1088).

export interface RelayNonceReservation {
   wallet: string;
   nonce: number;
   reservedAt: string;
   expiresAt: string;
}

export interface RelayNonceResponse {
   wallet: string;
   nonce: number;
   reserved: boolean;
   expiresInSeconds: number;
   expiresAt: string;
}

export interface RelaySubmitResult {
   wallet: string;
   nonce: number;
   txHash: string;
}

export interface RelayRateLimitInfo {
   allowed: boolean;
   limit: number;
   remaining: number;
   resetInSeconds: number;
}

/**
 * Pluggable signer: verifies that `signature` is a valid authorization from
 * `wallet` over `txParams`. Injected so tests can control signature outcomes
 * without depending on the network or a real keypair.
 */
export interface RelaySigner {
   verifySignature(
      wallet: string,
      signature: string,
      txParams: string
   ): Promise<boolean>;
}

/**
 * Pluggable submitter: transmits a signed transaction payload to the network
 * and returns the on-chain transaction hash. Injected so tests can confirm
 * submission only happens after successful validation.
 */
export interface RelaySubmitter {
   submitTransaction(signedPayload: string): Promise<{ txHash: string }>;
}
