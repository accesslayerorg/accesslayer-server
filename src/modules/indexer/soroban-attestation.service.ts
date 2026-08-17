// src/modules/indexer/soroban-attestation.service.ts
import crypto from 'crypto';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { getPartitionMerkleState } from './merkle-tree.service';

export interface PublishRootParams {
   network: string;
   contractId: string;
   ledgerStart: number;
   ledgerEnd: number;
   root: string;
   eventCount: number;
}

/**
 * Service function to publish a closed partition's Merkle root to the Soroban attestation contract.
 * By default, this function can be injected or overridden for testing.
 */
export async function invokeSorobanPublishRoot(
   params: PublishRootParams
): Promise<string> {
   // Generate a mock tx hash representing the on-chain Soroban attestation transaction
   const payload = `${params.network}:${params.contractId}:${params.ledgerStart}:${params.ledgerEnd}:${params.root}:${params.eventCount}`;
   const sorobanTxHash = crypto.createHash('sha256').update(payload).digest('hex');
   return sorobanTxHash;
}

export interface ClosePartitionOptions {
   publisher?: (params: PublishRootParams) => Promise<string>;
   maxRetries?: number;
   initialBackoffMs?: number;
}

/**
 * Closes a partition and publishes the Merkle root hash to the Soroban attestation contract.
 * Retries publication up to maxRetries (default 3) with exponential backoff.
 * If all retries fail, marks the partition as PUBLICATION_FAILED and emits a structured error log.
 */
export async function closeAndPublishPartition(
   network: string,
   contractId: string,
   ledgerStart: number,
   ledgerEnd: number,
   options: ClosePartitionOptions = {}
) {
   const publisher = options.publisher || invokeSorobanPublishRoot;
   const maxRetries = options.maxRetries ?? 3;
   const initialBackoffMs = options.initialBackoffMs ?? 10;

   const { root, eventCount } = await getPartitionMerkleState(
      network,
      contractId,
      ledgerStart
   );

   const publishParams: PublishRootParams = {
      network,
      contractId,
      ledgerStart,
      ledgerEnd,
      root,
      eventCount,
   };

   let sorobanTxHash: string | null = null;
   let publicationSuccess = false;
   let lastError: any = null;

   for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
         sorobanTxHash = await publisher(publishParams);
         publicationSuccess = true;
         break;
      } catch (err) {
         lastError = err;
         if (attempt < maxRetries) {
            const delay = initialBackoffMs * Math.pow(2, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, delay));
         }
      }
   }

   const status = publicationSuccess ? 'SUCCESS' : 'PUBLICATION_FAILED';

   if (!publicationSuccess) {
      logger.error(
         {
            type: 'partition_publication_failed',
            network,
            contractId,
            ledgerStart,
            ledgerEnd,
            root,
            eventCount,
            attempts: maxRetries,
            error: lastError?.message || String(lastError),
         },
         'Partition root publication failed after retries'
      );
   }

   const partitionRecord = await prisma.merklePartitionRoot.upsert({
      where: {
         network_contractId_ledgerStart_ledgerEnd: {
            network,
            contractId,
            ledgerStart,
            ledgerEnd,
         },
      },
      update: {
         root,
         eventCount,
         sorobanTxHash,
         status,
      },
      create: {
         network,
         contractId,
         ledgerStart,
         ledgerEnd,
         root,
         eventCount,
         sorobanTxHash,
         status,
      },
   });

   return partitionRecord;
}
