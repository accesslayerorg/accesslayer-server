jest.mock('../../../utils/prisma.utils', () => {
   const proposals: Record<string, any>[] = [];
   const signatures: Record<string, any>[] = [];
   let nextId = 1;

   const withSignatures = (proposal: Record<string, any>) => ({
      ...proposal,
      signatures: signatures.filter(
         signature => signature.proposalId === proposal.proposalId
      ),
   });
   const findProposal = (where: Record<string, string>) =>
      proposals.find(
         proposal =>
            proposal.proposalId === where.proposalId || proposal.id === where.id
      );

   const prisma: Record<string, any> = {
      multisigProposal: {
         create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
            const now = new Date();
            const proposal = {
               id: `proposal-${nextId++}`,
               proposedAt: now,
               executedAt: null,
               rejectedAt: null,
               rejectedBy: null,
               rejectionReason: null,
               createdAt: now,
               updatedAt: now,
               ...data,
            };
            proposals.push(proposal);
            return proposal;
         }),
         findMany: jest.fn(
            async ({
               where = {},
               skip = 0,
               take,
            }: {
               where?: Record<string, string>;
               skip?: number;
               take?: number;
            }) =>
               proposals
                  .filter(
                     proposal =>
                        !where.status || proposal.status === where.status
                  )
                  .sort(
                     (left, right) =>
                        right.createdAt.getTime() - left.createdAt.getTime()
                  )
                  .slice(skip, take === undefined ? undefined : skip + take)
                  .map(withSignatures)
         ),
         findUnique: jest.fn(
            async ({ where }: { where: Record<string, string> }) => {
               const proposal = findProposal(where);
               return proposal ? withSignatures(proposal) : null;
            }
         ),
         update: jest.fn(
            async ({
               where,
               data,
               include,
            }: {
               where: Record<string, string>;
               data: Record<string, any>;
               include?: Record<string, unknown>;
            }) => {
               const proposal = findProposal(where);
               if (!proposal) {
                  throw new Error('Proposal not found in test double');
               }
               Object.assign(proposal, data, { updatedAt: new Date() });
               return include?.signatures ? withSignatures(proposal) : proposal;
            }
         ),
         count: jest.fn(
            async ({ where = {} }: { where?: Record<string, string> }) =>
               proposals.filter(
                  proposal => !where.status || proposal.status === where.status
               ).length
         ),
         deleteMany: jest.fn(async () => {
            const count = proposals.length;
            proposals.length = 0;
            return { count };
         }),
      },
      multisigSignature: {
         create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
            const signature = {
               id: `signature-${nextId++}`,
               signedAt: new Date(),
               ...data,
            };
            signatures.push(signature);
            return signature;
         }),
         deleteMany: jest.fn(async () => {
            const count = signatures.length;
            signatures.length = 0;
            return { count };
         }),
      },
      auditEvent: { create: jest.fn(async () => ({})) },
      auditLog: { create: jest.fn(async () => ({})) },
      $transaction: jest.fn(
         async (
            callback: (transaction: any) => Promise<unknown>
         ): Promise<unknown> => callback(prisma)
      ),
   };

   return { prisma };
});

import { prisma } from '../../../utils/prisma.utils';
import { Keypair } from '@stellar/stellar-base';
import {
   createMultisigProposal,
   getMultisigProposalQueue,
   getMultisigProposalById,
   signMultisigProposal,
   rejectMultisigProposal,
   MultisigProposalNotFoundError,
   MultisigProposalInvalidStateError,
   MultisigSignerNotAuthorizedError,
   MultisigDuplicateSignatureError,
} from '../multisig-proposal.service';

jest.mock('../../../config', () => {
   const actual = jest.requireActual('../../../config');
   return {
      ...actual,
      envConfig: {
         ...actual.envConfig,
         ADMIN_MULTISIG_WALLETS: [
            `G${'A'.repeat(55)}`,
            `G${'B'.repeat(55)}`,
            `G${'C'.repeat(55)}`,
         ].join(','),
      },
   };
});

describe('Multisig Proposal Service', () => {
   const ADMIN_1 = `G${'A'.repeat(55)}`;
   const ADMIN_2 = `G${'B'.repeat(55)}`;
   const ADMIN_3 = `G${'C'.repeat(55)}`;
   const NON_ADMIN = Keypair.random().publicKey();

   beforeEach(async () => {
      await prisma.multisigSignature.deleteMany();
      await prisma.multisigProposal.deleteMany();
   });

   describe('createMultisigProposal', () => {
      it('should create a proposal with defaults', async () => {
         const result = await createMultisigProposal({
            changeType: 'test',
            payload: { key: 'value' },
            proposedBy: ADMIN_1,
         });

         expect(result.proposalId).toMatch(/^msig-\d+-[a-z0-9]+$/);
         expect(result.changeType).toBe('test');
         expect(result.status).toBe('pending');
         expect(result.threshold).toBe(2);
         expect(result.totalSigners).toBe(3);
         expect(result.proposedBy).toBe(ADMIN_1);
         expect(result.approvalCount).toBe(0);
         expect(result.signatures).toHaveLength(0);
      });

      it('should create a proposal with custom threshold', async () => {
         const result = await createMultisigProposal({
            changeType: 'test',
            payload: {},
            threshold: 3,
            totalSigners: 5,
            proposedBy: ADMIN_1,
         });

         expect(result.threshold).toBe(3);
         expect(result.totalSigners).toBe(5);
      });

      it('should throw on invalid threshold > totalSigners', async () => {
         await expect(
            createMultisigProposal({
               changeType: 'test',
               payload: {},
               threshold: 5,
               totalSigners: 3,
               proposedBy: ADMIN_1,
            })
         ).rejects.toThrow('Invalid threshold');
      });
   });

   describe('getMultisigProposalQueue', () => {
      it('should return paginated results', async () => {
         await createMultisigProposal({
            changeType: 'a',
            payload: {},
            proposedBy: ADMIN_1,
         });
         await createMultisigProposal({
            changeType: 'b',
            payload: {},
            proposedBy: ADMIN_1,
         });

         const result = await getMultisigProposalQueue({ page: 1, limit: 10 });
         expect(result.items).toHaveLength(2);
         expect(result.meta.totalCount).toBe(2);
         expect(result.meta.page).toBe(1);
      });

      it('should filter by status', async () => {
         const p1 = await createMultisigProposal({
            changeType: 'a',
            payload: {},
            proposedBy: ADMIN_1,
         });
         await createMultisigProposal({
            changeType: 'b',
            payload: {},
            proposedBy: ADMIN_1,
         });

         // Execute first proposal
         await signMultisigProposal({
            proposalId: p1.proposalId,
            signer: ADMIN_1,
         });
         await signMultisigProposal({
            proposalId: p1.proposalId,
            signer: ADMIN_2,
         });

         const pending = await getMultisigProposalQueue({ status: 'pending' });
         expect(pending.items.every(p => p.status === 'pending')).toBe(true);

         const executed = await getMultisigProposalQueue({
            status: 'executed',
         });
         expect(executed.items.every(p => p.status === 'executed')).toBe(true);
      });
   });

   describe('getMultisigProposalById', () => {
      it('should return proposal with signatures', async () => {
         const created = await createMultisigProposal({
            changeType: 'test',
            payload: {},
            proposedBy: ADMIN_1,
         });
         await signMultisigProposal({
            proposalId: created.proposalId,
            signer: ADMIN_1,
         });

         const result = await getMultisigProposalById(created.proposalId);
         expect(result.proposalId).toBe(created.proposalId);
         expect(result.signatures).toHaveLength(1);
         expect(result.signatures[0].signer).toBe(ADMIN_1);
      });

      it('should throw MultisigProposalNotFoundError for unknown proposal', async () => {
         await expect(
            getMultisigProposalById('msig-unknown-123')
         ).rejects.toThrow(MultisigProposalNotFoundError);
      });
   });

   describe('signMultisigProposal', () => {
      let proposalId: string;

      beforeEach(async () => {
         const created = await createMultisigProposal({
            changeType: 'test',
            payload: {},
            proposedBy: ADMIN_1,
         });
         proposalId = created.proposalId;
      });

      it('should add signature and increment approval count', async () => {
         const result = await signMultisigProposal({
            proposalId,
            signer: ADMIN_1,
         });
         expect(result.approvalCount).toBe(1);
         expect(result.signature.signer).toBe(ADMIN_1);
         expect(result.executed).toBe(false);
      });

      it('should execute when threshold reached', async () => {
         await signMultisigProposal({ proposalId, signer: ADMIN_1 });
         const result = await signMultisigProposal({
            proposalId,
            signer: ADMIN_2,
         });

         expect(result.executed).toBe(true);
         expect(result.status).toBe('executed');
         expect(result.approvalCount).toBe(2);
      });

      it('should throw MultisigProposalNotFoundError for unknown proposal', async () => {
         await expect(
            signMultisigProposal({
               proposalId: 'msig-unknown-123',
               signer: ADMIN_1,
            })
         ).rejects.toThrow(MultisigProposalNotFoundError);
      });

      it('should throw MultisigProposalInvalidStateError for executed proposal', async () => {
         await signMultisigProposal({ proposalId, signer: ADMIN_1 });
         await signMultisigProposal({ proposalId, signer: ADMIN_2 });

         await expect(
            signMultisigProposal({ proposalId, signer: ADMIN_3 })
         ).rejects.toThrow(MultisigProposalInvalidStateError);
      });

      it('should throw MultisigProposalInvalidStateError for rejected proposal', async () => {
         await rejectMultisigProposal({ proposalId, rejector: ADMIN_1 });

         await expect(
            signMultisigProposal({ proposalId, signer: ADMIN_2 })
         ).rejects.toThrow(MultisigProposalInvalidStateError);
      });

      it('should throw MultisigSignerNotAuthorizedError for unauthorized signer', async () => {
         await expect(
            signMultisigProposal({ proposalId, signer: NON_ADMIN })
         ).rejects.toThrow(MultisigSignerNotAuthorizedError);
      });

      it('should throw MultisigDuplicateSignatureError for duplicate signer', async () => {
         await signMultisigProposal({ proposalId, signer: ADMIN_1 });

         await expect(
            signMultisigProposal({ proposalId, signer: ADMIN_1 })
         ).rejects.toThrow(MultisigDuplicateSignatureError);
      });
   });

   describe('rejectMultisigProposal', () => {
      let proposalId: string;

      beforeEach(async () => {
         const created = await createMultisigProposal({
            changeType: 'test',
            payload: {},
            proposedBy: ADMIN_1,
         });
         proposalId = created.proposalId;
      });

      it('should reject proposal and record rejector and timestamp', async () => {
         const result = await rejectMultisigProposal({
            proposalId,
            rejector: ADMIN_1,
            reason: 'Test reason',
         });

         expect(result.status).toBe('rejected');
         expect(result.rejectedBy).toBe(ADMIN_1);
         expect(result.rejectionReason).toBe('Test reason');
         expect(result.rejectedAt).toBeInstanceOf(Date);
      });

      it('should throw MultisigProposalNotFoundError for unknown proposal', async () => {
         await expect(
            rejectMultisigProposal({
               proposalId: 'msig-unknown-123',
               rejector: ADMIN_1,
            })
         ).rejects.toThrow(MultisigProposalNotFoundError);
      });

      it('should throw MultisigProposalInvalidStateError for executed proposal', async () => {
         await signMultisigProposal({ proposalId, signer: ADMIN_1 });
         await signMultisigProposal({ proposalId, signer: ADMIN_2 });

         await expect(
            rejectMultisigProposal({ proposalId, rejector: ADMIN_3 })
         ).rejects.toThrow(MultisigProposalInvalidStateError);
      });

      it('should throw MultisigProposalInvalidStateError for already rejected proposal', async () => {
         await rejectMultisigProposal({ proposalId, rejector: ADMIN_1 });

         await expect(
            rejectMultisigProposal({ proposalId, rejector: ADMIN_2 })
         ).rejects.toThrow(MultisigProposalInvalidStateError);
      });

      it('should throw MultisigSignerNotAuthorizedError for unauthorized rejector', async () => {
         await expect(
            rejectMultisigProposal({ proposalId, rejector: NON_ADMIN })
         ).rejects.toThrow(MultisigSignerNotAuthorizedError);
      });
   });
});
