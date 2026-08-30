import { horizonGet } from '../../clients/horizon.client';
import {
   SorobanTransactionGateway,
   SorobanTransactionStatus,
} from './soroban-wal.types';

export type SubmitSorobanXdr = (
   xdrPayload: string
) => Promise<{ txHash: string }>;

export class HorizonSorobanGateway implements SorobanTransactionGateway {
   constructor(private readonly submitXdr?: SubmitSorobanXdr) {}

   async submit(xdrPayload: string): Promise<{ txHash: string }> {
      if (!this.submitXdr) {
         throw new Error('Soroban submission adapter is not configured');
      }
      return this.submitXdr(xdrPayload);
   }

   async getStatus(txHash: string): Promise<SorobanTransactionStatus> {
      const response = await horizonGet(
         `/transactions/${encodeURIComponent(txHash)}`
      );

      if (response.status === 404) return { status: 'PENDING' };
      if (!response.ok) {
         return {
            status: 'FAILED',
            error: `Horizon returned HTTP ${response.status} for ${txHash}`,
         };
      }

      const transaction = (await response.json()) as { successful?: boolean };
      return transaction.successful === false
         ? { status: 'FAILED', error: `Transaction ${txHash} failed on-chain` }
         : { status: 'CONFIRMED' };
   }
}
