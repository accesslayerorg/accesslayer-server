// src/modules/events/events.types.ts
// Merkle-proof event integrity types (#727)

import type { MerkleProofSibling } from '../../utils/merkle';

export interface IngestEventInput {
   network: string;
   contractId: string;
   ledger: number;
   txHash: string;
   eventIndex: number;
   topic: string;
   dataJson: unknown;
}

export interface IngestEventResult {
   event: {
      id: string;
      network: string;
      contractId: string;
      ledger: number;
      txHash: string;
      eventIndex: number;
      topic: string;
      dataJson: string;
      leafHash: string;
      leafIndex: number;
      partitionId: string;
      createdAt: Date;
   };
   partitionClosed: boolean;
   root?: string;
   partitionRoot?: unknown;
}

export interface EventInclusionProofResponse {
   leafHash: string;
   leafIndex: number;
   treeSize: number;
   root: string;
   siblings: MerkleProofSibling[];
   partitionId: string;
   sorobanTxHash: string | null;
}

export interface PublishRootParams {
   network: string;
   contractId: string;
   ledgerStart: number;
   ledgerEnd: number;
   root: string;
   eventCount: number;
}
