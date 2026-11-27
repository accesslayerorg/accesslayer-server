jest.mock('../../config', () => ({
   envConfig: { JWT_SECRET: 'x'.repeat(48) },
}));
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn(), update: jest.fn() },
      verificationApplication: {
         findFirst: jest.fn(),
         findUnique: jest.fn(),
         findMany: jest.fn(),
         count: jest.fn(),
         create: jest.fn(),
         updateMany: jest.fn(),
      },
      verificationProof: { update: jest.fn() },
      verificationDecision: { create: jest.fn() },
      $transaction: jest.fn(),
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   claimVerificationApplication,
   CreatorProfileMissingError,
   createProofCode,
   decideVerificationApplication,
   hashLegalName,
   InvalidProofLinkError,
   runVerificationProofCheck,
   submitVerificationApplication,
   validateProofLinks,
   VerificationConflictError,
} from './creator-verification.service';
import { ProofCheckService } from './proof-check.service';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock };
const NOW = new Date('2026-11-24T12:00:00Z');

function setTransaction(tx: Record<string, Record<string, jest.Mock>>) {
   db.$transaction.mockImplementation(async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (t: unknown) => unknown)(tx) : Promise.all(arg as unknown[])
   );
}

function appRow(overrides: Record<string, unknown> = {}) {
   return {
      id: 'app-1',
      creatorId: 'creator-1',
      status: 'in_review',
      proofCode: 'AL-VERIFY-ABCDEF123456',
      reviewerId: 'admin-1',
      decisionNote: null,
      submittedAt: NOW,
      decidedAt: null,
      proofs: [
         {
            id: 'p1',
            provider: 'github',
            url: 'https://github.com/ada',
            status: 'passed',
            failureReason: null,
            checkedAt: NOW,
         },
      ],
      ...overrides,
   };
}

beforeEach(() => {
   jest.clearAllMocks();
});

describe('validateProofLinks', () => {
   it('rejects a provider link on the wrong site and names the field', () => {
      expect(() => validateProofLinks([{ provider: 'github', url: 'https://gitlab.com/ada' }])).toThrow(
         InvalidProofLinkError
      );
      try {
         validateProofLinks([{ provider: 'github', url: 'https://gitlab.com/ada' }]);
      } catch (error) {
         expect((error as InvalidProofLinkError).field).toBe('links.0.url');
      }
   });

   it('requires at least one link', () => {
      expect(() => validateProofLinks([])).toThrow(InvalidProofLinkError);
   });

   it('returns normalized URLs for valid links', () => {
      expect(validateProofLinks([{ provider: 'github', url: 'https://github.com/ada' }])).toEqual([
         { provider: 'github', url: 'https://github.com/ada' },
      ]);
   });
});

describe('legal name and proof code', () => {
   it('hashes the normalized name so spacing and case do not change it', () => {
      expect(hashLegalName('  Ada   Lovelace ')).toBe(hashLegalName('ada lovelace'));
      expect(hashLegalName('Ada Lovelace')).not.toContain('Ada');
   });

   it('creates codes that are unique-looking and typeable', () => {
      expect(createProofCode()).toMatch(/^AL-VERIFY-[0-9A-F]{12}$/);
      expect(createProofCode()).not.toBe(createProofCode());
   });
});

describe('submitVerificationApplication', () => {
   const input = {
      legalName: 'Ada Lovelace',
      links: [{ provider: 'github' as const, url: 'https://github.com/ada' }],
   };

   it('requires a creator profile', async () => {
      db.creatorProfile.findFirst.mockResolvedValue(null);
      await expect(submitVerificationApplication('user-1', input, NOW)).rejects.toBeInstanceOf(
         CreatorProfileMissingError
      );
   });

   it('refuses an already verified creator', async () => {
      db.creatorProfile.findFirst.mockResolvedValue({ id: 'creator-1', isVerified: true });
      await expect(submitVerificationApplication('user-1', input, NOW)).rejects.toBeInstanceOf(
         VerificationConflictError
      );
   });

   it('refuses while an application is still open', async () => {
      db.creatorProfile.findFirst.mockResolvedValue({ id: 'creator-1', isVerified: false });
      db.verificationApplication.findFirst.mockResolvedValue({ id: 'app-0' });
      await expect(submitVerificationApplication('user-1', input, NOW)).rejects.toBeInstanceOf(
         VerificationConflictError
      );
      expect(db.verificationApplication.create).not.toHaveBeenCalled();
   });

   it('files a submitted application with a unique proof code and one proof per link', async () => {
      db.creatorProfile.findFirst.mockResolvedValue({ id: 'creator-1', isVerified: false });
      db.verificationApplication.findFirst.mockResolvedValue(null);
      db.verificationApplication.create.mockImplementation(async ({ data }) => ({
         id: 'app-2',
         creatorId: data.creatorId,
         status: data.status,
         proofCode: data.proofCode,
         reviewerId: null,
         decisionNote: null,
         submittedAt: NOW,
         decidedAt: null,
         proofs: [
            { id: 'p9', provider: 'github', url: 'https://github.com/ada', status: 'pending', failureReason: null, checkedAt: null },
         ],
      }));

      const view = await submitVerificationApplication('user-1', input, NOW);

      const created = db.verificationApplication.create.mock.calls[0][0].data;
      expect(created.status).toBe('submitted');
      expect(created.legalNameHash).toBe(hashLegalName('Ada Lovelace'));
      expect(created.proofs.create).toEqual([{ provider: 'github', url: 'https://github.com/ada' }]);
      expect(view.proofCode).toMatch(/^AL-VERIFY-/);
      expect(view.proofs[0].status).toBe('pending');
   });
});

describe('claimVerificationApplication', () => {
   it('moves a submitted application to in_review for the reviewer', async () => {
      db.verificationApplication.findUnique
         .mockResolvedValueOnce({ status: 'submitted' })
         .mockResolvedValueOnce(appRow());
      const tx = {
         verificationApplication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
         verificationDecision: { create: jest.fn() },
      };
      setTransaction(tx);

      await claimVerificationApplication('app-1', 'admin-1', NOW);

      expect(tx.verificationApplication.updateMany).toHaveBeenCalledWith({
         where: { id: 'app-1', status: 'submitted' },
         data: { status: 'in_review', reviewerId: 'admin-1', reviewedAt: NOW },
      });
      expect(tx.verificationDecision.create).toHaveBeenCalledWith({
         data: expect.objectContaining({ applicationId: 'app-1', status: 'in_review', reviewerId: 'admin-1' }),
      });
   });

   it('refuses to claim an application that is already in review', async () => {
      db.verificationApplication.findUnique.mockResolvedValue({ status: 'in_review' });
      await expect(claimVerificationApplication('app-1', 'admin-2', NOW)).rejects.toBeInstanceOf(
         VerificationConflictError
      );
   });
});

describe('runVerificationProofCheck', () => {
   it('refuses a check on a decided application', async () => {
      db.verificationApplication.findUnique.mockResolvedValue({ id: 'app-1', status: 'approved', proofs: [] });
      await expect(runVerificationProofCheck('app-1', new ProofCheckService({} as never), NOW)).rejects.toBeInstanceOf(
         VerificationConflictError
      );
   });

   it('stores each link result on its proof', async () => {
      db.verificationApplication.findUnique
         .mockResolvedValueOnce({
            id: 'app-1',
            status: 'in_review',
            proofCode: 'AL-VERIFY-ABCDEF123456',
            proofs: [{ id: 'p1', provider: 'github', url: 'https://github.com/ada' }],
         })
         .mockResolvedValueOnce(appRow());
      db.verificationProof.update.mockResolvedValue({});
      const checker = new ProofCheckService({
         github: { fetchPage: jest.fn().mockResolvedValue('AL-VERIFY-ABCDEF123456') },
         twitter: { fetchPage: jest.fn() },
         website: { fetchPage: jest.fn() },
      });

      const result = await runVerificationProofCheck('app-1', checker, NOW);

      expect(result.passed).toBe(true);
      expect(db.verificationProof.update).toHaveBeenCalledWith({
         where: { id: 'p1' },
         data: { status: 'passed', failureReason: null, checkedAt: NOW },
      });
   });
});

describe('decideVerificationApplication', () => {
   it('refuses approval until every linked account has passed the proof check', async () => {
      db.verificationApplication.findUnique.mockResolvedValue(
         appRow({
            proofs: [
               { id: 'p1', status: 'passed' },
               { id: 'p2', status: 'failed' },
            ],
         })
      );
      await expect(
         decideVerificationApplication('app-1', 'admin-1', { decision: 'approved', note: 'Looks good' }, NOW)
      ).rejects.toBeInstanceOf(VerificationConflictError);
      expect(db.$transaction).not.toHaveBeenCalled();
   });

   it('refuses a decision from a different reviewer', async () => {
      db.verificationApplication.findUnique.mockResolvedValue(appRow());
      await expect(
         decideVerificationApplication('app-1', 'admin-2', { decision: 'rejected', note: 'Not a match' }, NOW)
      ).rejects.toBeInstanceOf(VerificationConflictError);
   });

   it('refuses a decision on an application that was never claimed', async () => {
      db.verificationApplication.findUnique.mockResolvedValue(appRow({ status: 'submitted', reviewerId: null }));
      await expect(
         decideVerificationApplication('app-1', 'admin-1', { decision: 'approved', note: 'Looks good' }, NOW)
      ).rejects.toBeInstanceOf(VerificationConflictError);
   });

   it('approves and sets the verified flag with its timestamp in the same transaction', async () => {
      db.verificationApplication.findUnique
         .mockResolvedValueOnce(appRow())
         .mockResolvedValueOnce(appRow({ status: 'approved', decidedAt: NOW, decisionNote: 'Verified on GitHub' }));
      const tx = {
         verificationApplication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
         verificationDecision: { create: jest.fn() },
         creatorProfile: { update: jest.fn() },
      };
      setTransaction(tx);

      const view = await decideVerificationApplication(
         'app-1',
         'admin-1',
         { decision: 'approved', note: 'Verified on GitHub' },
         NOW
      );

      expect(view.status).toBe('approved');
      expect(tx.creatorProfile.update).toHaveBeenCalledWith({
         where: { id: 'creator-1' },
         data: { isVerified: true, verifiedAt: NOW },
      });
      expect(tx.verificationDecision.create).toHaveBeenCalledWith({
         data: expect.objectContaining({ status: 'approved', reviewerId: 'admin-1', note: 'Verified on GitHub' }),
      });
   });

   it('rejects without changing the creator and keeps the decision on record', async () => {
      db.verificationApplication.findUnique
         .mockResolvedValueOnce(appRow({ proofs: [{ id: 'p1', status: 'failed' }] }))
         .mockResolvedValueOnce(appRow({ status: 'rejected', decidedAt: NOW, decisionNote: 'Name mismatch' }));
      const tx = {
         verificationApplication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
         verificationDecision: { create: jest.fn() },
         creatorProfile: { update: jest.fn() },
      };
      setTransaction(tx);

      const view = await decideVerificationApplication(
         'app-1',
         'admin-1',
         { decision: 'rejected', note: 'Name mismatch' },
         NOW
      );

      expect(view.status).toBe('rejected');
      expect(tx.creatorProfile.update).not.toHaveBeenCalled();
      expect(tx.verificationDecision.create).toHaveBeenCalledTimes(1);
   });
});
