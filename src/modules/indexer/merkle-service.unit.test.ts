// src/modules/indexer/merkle-service.unit.test.ts
import { prisma } from '../../utils/prisma.utils';
import {
   ingestEventAndExtendTree,
   getPartitionMerkleState,
   generateInclusionProof,
} from './merkle-tree.service';
import { closeAndPublishPartition } from './soroban-attestation.service';
import { canonicalLeafHash } from '../../utils/merkle';
import { logger } from '../../utils/logger.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      event: {
         create: jest.fn(),
         findUnique: jest.fn(),
         deleteMany: jest.fn(),
      },
      merkleTreeState: {
         count: jest.fn(),
         upsert: jest.fn(),
         findUnique: jest.fn(),
         findFirst: jest.fn(),
         deleteMany: jest.fn(),
      },
      merklePartitionRoot: {
         upsert: jest.fn(),
         findUnique: jest.fn(),
         deleteMany: jest.fn(),
      },
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockPrisma = prisma as unknown as {
   event: {
      create: jest.Mock;
      findUnique: jest.Mock;
      deleteMany: jest.Mock;
   };
   merkleTreeState: {
      count: jest.Mock;
      upsert: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      deleteMany: jest.Mock;
   };
   merklePartitionRoot: {
      upsert: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      deleteMany: jest.Mock;
   };
};

beforeEach(() => {
   jest.clearAllMocks();
});

describe('MerkleTreeService Unit Tests', () => {
   describe('ingestEventAndExtendTree', () => {
      it('creates event and updates tree nodes in O(log n)', async () => {
         const eventInput = {
            network: 'testnet',
            contractId: 'C123',
            ledger: 10,
            txHash: 'tx_10',
            eventIndex: 0,
            topic: 'BUY',
            dataJson: { buyer: 'G1' },
         };

         const computedHash = canonicalLeafHash(eventInput);

         mockPrisma.event.create.mockResolvedValue({
            id: 'ev-1',
            ...eventInput,
            leafHash: computedHash,
         });

         // First leaf inserted (leafCount = 0)
         mockPrisma.merkleTreeState.count
            .mockResolvedValueOnce(0) // level 0 leaf count
            .mockResolvedValueOnce(1); // level 1 node count -> top reached

         mockPrisma.merkleTreeState.upsert.mockResolvedValue({});

         const result = await ingestEventAndExtendTree(eventInput);

         expect(result.event.id).toBe('ev-1');
         expect(result.rootHash).toBe(computedHash);
         expect(mockPrisma.event.create).toHaveBeenCalled();
         expect(mockPrisma.merkleTreeState.upsert).toHaveBeenCalledTimes(2); // level 0 + level 1 promoted
      });
   });

   describe('getPartitionMerkleState', () => {
      it('returns empty root when no events exist in partition', async () => {
         mockPrisma.merkleTreeState.count.mockResolvedValue(0);
         const res = await getPartitionMerkleState('testnet', 'C123', 0);
         expect(res).toEqual({ root: '', eventCount: 0 });
      });

      it('returns root hash and count when events exist', async () => {
         mockPrisma.merkleTreeState.count.mockResolvedValue(8);
         mockPrisma.merkleTreeState.findFirst.mockResolvedValue({
            hash: 'root_hash_8',
            level: 3,
            position: 0,
         });

         const res = await getPartitionMerkleState('testnet', 'C123', 0);
         expect(res).toEqual({ root: 'root_hash_8', eventCount: 8 });
      });
   });

   describe('generateInclusionProof', () => {
      it('returns null if event is not found', async () => {
         mockPrisma.event.findUnique.mockResolvedValue(null);
         const proof = await generateInclusionProof('nonexistent');
         expect(proof).toBeNull();
      });

      it('returns null if partition is open or not successfully published', async () => {
         mockPrisma.event.findUnique.mockResolvedValue({
            id: 'ev-1',
            network: 'testnet',
            contractId: 'C123',
            ledger: 50,
            leafHash: 'leaf_hash_1',
         });

         mockPrisma.merklePartitionRoot.findUnique.mockResolvedValue(null);

         const proof = await generateInclusionProof('ev-1');
         expect(proof).toBeNull();
      });
   });

   describe('closeAndPublishPartition', () => {
      it('publishes root and stores partition record on success', async () => {
         mockPrisma.merkleTreeState.count.mockResolvedValue(4);
         mockPrisma.merkleTreeState.findFirst.mockResolvedValue({
            hash: 'root_4_leaves',
         });

         mockPrisma.merklePartitionRoot.upsert.mockResolvedValue({
            id: 'part-1',
            network: 'testnet',
            contractId: 'C123',
            ledgerStart: 0,
            ledgerEnd: 999,
            root: 'root_4_leaves',
            eventCount: 4,
            sorobanTxHash: 'soroban_tx_123',
            status: 'SUCCESS',
         });

         const mockPublisher = jest.fn().mockResolvedValue('soroban_tx_123');

         const res = await closeAndPublishPartition('testnet', 'C123', 0, 999, {
            publisher: mockPublisher,
         });

         expect(mockPublisher).toHaveBeenCalledTimes(1);
         expect(res.status).toBe('SUCCESS');
         expect(res.sorobanTxHash).toBe('soroban_tx_123');
      });

      it('retries publication up to maxRetries and marks PUBLICATION_FAILED if all fail', async () => {
         mockPrisma.merkleTreeState.count.mockResolvedValue(4);
         mockPrisma.merkleTreeState.findFirst.mockResolvedValue({
            hash: 'root_4_leaves',
         });

         mockPrisma.merklePartitionRoot.upsert.mockResolvedValue({
            id: 'part-1',
            network: 'testnet',
            contractId: 'C123',
            ledgerStart: 0,
            ledgerEnd: 999,
            root: 'root_4_leaves',
            eventCount: 4,
            sorobanTxHash: null,
            status: 'PUBLICATION_FAILED',
         });

         let count = 0;
         const mockFailingPublisher = jest.fn().mockImplementation(async () => {
            count++;
            throw new Error(`RPC connection timeout ${count}`);
         });

         const res = await closeAndPublishPartition('testnet', 'C123', 0, 999, {
            publisher: mockFailingPublisher,
            maxRetries: 3,
            initialBackoffMs: 1,
         });

         expect(mockFailingPublisher).toHaveBeenCalledTimes(3);
         expect(res.status).toBe('PUBLICATION_FAILED');
         expect(res.sorobanTxHash).toBeNull();
         expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
               type: 'partition_publication_failed',
               attempts: 3,
            }),
            'Partition root publication failed after retries'
         );
      });
   });
});
