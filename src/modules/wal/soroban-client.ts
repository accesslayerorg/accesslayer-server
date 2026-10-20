import { ISorobanClient, HorizonTxResult } from './wal.types';
import { logger } from '../../utils/logger.utils';

export class HorizonSorobanClient implements ISorobanClient {
   private horizonUrl: string;

   constructor(horizonUrl?: string) {
      this.horizonUrl =
         horizonUrl ||
         process.env.HORIZON_URL ||
         'https://horizon-testnet.stellar.org';
   }

   async submitTransaction(xdrPayload: string): Promise<{ txHash: string }> {
      try {
         const url = `${this.horizonUrl.replace(/\/$/, '')}/transactions`;
         const params = new URLSearchParams();
         params.append('tx', xdrPayload);

         const response = await fetch(url, {
            method: 'POST',
            headers: {
               'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
         });

         const data = (await response.json()) as any;

         if (!response.ok) {
            const errorDetail =
               data?.extras?.result_codes?.transaction ||
               data?.title ||
               data?.detail ||
               `Horizon submission failed with status ${response.status}`;
            throw new Error(errorDetail);
         }

         const txHash = data.hash || data.id;
         if (!txHash) {
            throw new Error(
               'Transaction submission succeeded but no hash returned'
            );
         }

         return { txHash };
      } catch (error: any) {
         logger.error(
            { error: error.message },
            'Error submitting transaction to Horizon'
         );
         throw error;
      }
   }

   async getTransactionResult(txHash: string): Promise<HorizonTxResult> {
      try {
         const url = `${this.horizonUrl.replace(/\/$/, '')}/transactions/${txHash}`;
         const response = await fetch(url, {
            method: 'GET',
            headers: {
               Accept: 'application/json',
            },
         });

         if (response.status === 404) {
            return { status: 'PENDING' };
         }

         const data = (await response.json()) as any;

         if (!response.ok) {
            return {
               status: 'FAILED',
               error:
                  data?.title ||
                  data?.detail ||
                  `Horizon query failed with status ${response.status}`,
            };
         }

         if (data.successful === true) {
            return {
               status: 'SUCCESS',
               ledger: data.ledger,
            };
         } else if (data.successful === false) {
            return {
               status: 'FAILED',
               error:
                  data?.extras?.result_codes?.transaction ||
                  'Transaction rejected by network',
            };
         }

         return { status: 'PENDING' };
      } catch (error: any) {
         logger.warn(
            { txHash, error: error.message },
            'Failed to query transaction status from Horizon'
         );
         // Network error or timeout during query - treat as pending so caller can retry
         return { status: 'PENDING' };
      }
   }
}

export const defaultSorobanClient = new HorizonSorobanClient();
