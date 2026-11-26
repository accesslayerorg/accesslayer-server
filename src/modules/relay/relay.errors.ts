// src/modules/relay/relay.errors.ts
// Domain errors for the gasless meta-transaction relay flow (#1088).

export class RelayNonceNotReservedError extends Error {
   public readonly status = 404;

   constructor(
      public readonly wallet: string,
      public readonly nonce: number
   ) {
      super(
         `No active nonce reservation for wallet ${wallet} at nonce ${nonce}`
      );
      this.name = 'RelayNonceNotReservedError';
   }
}

export class RelayNonceExpiredError extends Error {
   public readonly status = 410;

   constructor(
      public readonly wallet: string,
      public readonly nonce: number
   ) {
      super(`Nonce reservation ${nonce} for wallet ${wallet} has expired`);
      this.name = 'RelayNonceExpiredError';
   }
}

export class RelayNonceAlreadyUsedError extends Error {
   public readonly status = 409;

   constructor(
      public readonly wallet: string,
      public readonly nonce: number
   ) {
      super(`Nonce ${nonce} for wallet ${wallet} has already been used`);
      this.name = 'RelayNonceAlreadyUsedError';
   }
}

export class RelayInvalidSignatureError extends Error {
   public readonly status = 400;

   constructor(message = 'Invalid signature for the supplied transaction') {
      super(message);
      this.name = 'RelayInvalidSignatureError';
   }
}

export class RelaySubmissionError extends Error {
   public readonly status = 502;

   constructor(public readonly cause?: unknown) {
      super(
         `Relay transaction submission failed: ${
            cause instanceof Error ? cause.message : String(cause)
         }`
      );
      this.name = 'RelaySubmissionError';
   }
}
