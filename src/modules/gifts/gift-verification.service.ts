export interface SorobanClientLike {
   getTransferEventsByTxHash(txHash: string): Promise<SorobanTransferEvent[]>;
}

export interface TransferMatchInput {
   txHash: string;
   sender: string;
   recipient: string;
   quantity: number;
   keyId: string;
}

export interface VerifiedTransfer {
   keyId: string;
   quantity: number;
}

export interface SorobanTransferEvent {
   from: string;
   to: string;
   quantity: number;
   keyId: string;
}

export class GiftVerificationError extends Error {
   constructor(
      message: string,
      public readonly code: 'NOT_FOUND' | 'MISMATCH'
   ) {
      super(message);
      this.name = 'GiftVerificationError';
   }
}

/**
 * Verifies that an on-chain key transfer matches the claimed sender, recipient
 * and quantity. Only transfers that match are eligible to produce a Gift record.
 */
export class GiftVerificationService {
   constructor(private readonly client: SorobanClientLike) {}

   /**
    * Fetches the transaction from the Soroban client, extracts the transfer
    * event and compares sender, recipient and quantity.
    *
    * @throws {GiftVerificationError} NOT_FOUND if no transfer event exists for the tx,
    *         MISMATCH if the transfer does not match the provided fields.
    */
   async verify(
      txHash: string,
      sender: string,
      recipient: string,
      quantity?: number,
      keyId?: string
   ): Promise<VerifiedTransfer> {
      const transfers: SorobanTransferEvent[] =
         await this.client.getTransferEventsByTxHash(txHash);

      if (!transfers || transfers.length === 0) {
         throw new GiftVerificationError(
            `No transfer event found for tx ${txHash}`,
            'NOT_FOUND'
         );
      }

      const match = transfers.find(
         (t: SorobanTransferEvent): boolean =>
            t.from === sender &&
            t.to === recipient &&
            (quantity === undefined || t.quantity === quantity) &&
            (keyId === undefined || t.keyId === keyId)
      );

      if (!match) {
         throw new GiftVerificationError(
            `On-chain transfer does not match sender, recipient or quantity for tx ${txHash}`,
            'MISMATCH'
         );
      }

      return { keyId: match.keyId, quantity: match.quantity };
   }
}

export const giftVerificationService = new GiftVerificationService({
   getTransferEventsByTxHash: async (): Promise<SorobanTransferEvent[]> => {
      throw new Error('Soroban client not configured for gift verification');
   },
});
