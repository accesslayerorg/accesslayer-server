// src/modules/nonce/nonce.errors.ts
// Domain errors for nonce management and replay detection (#1039).

export class NonceAlreadyConsumedError extends Error {
   public readonly status = 409;

   constructor(
      public readonly wallet: string,
      public readonly nonce: number
   ) {
      super(`Nonce ${nonce} for wallet ${wallet} has already been consumed`);
      this.name = 'NonceAlreadyConsumedError';
   }
}

export class NonceMismatchError extends Error {
   public readonly status = 400;

   constructor(
      public readonly wallet: string,
      public readonly expectedNonce: number,
      public readonly providedNonce: number
   ) {
      super(
         `Invalid nonce for wallet ${wallet}: expected ${expectedNonce}, received ${providedNonce}`
      );
      this.name = 'NonceMismatchError';
   }
}

export class NonceContractUnavailableError extends Error {
   public readonly status = 503;

   constructor(message: string = 'Nonce registry contract is unavailable') {
      super(message);
      this.name = 'NonceContractUnavailableError';
   }
}
