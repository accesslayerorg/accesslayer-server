// src/modules/creator-verification/creator-verification.service.ts
// Verified badge workflow for creators (#1324).
//
// A creator applies with linked accounts. Each account must show the
// application's proof code. A reviewer claims the application, the proof check
// runs, and then the reviewer approves or rejects it with a note. Approval
// sets the creator's verified flag and `verifiedAt`. Every reviewer action is
// recorded. A rejected creator can apply again.

import { createHmac, randomBytes } from 'crypto';
import { envConfig } from '../../config';
import { PaginationMetadata } from '../../utils/api-response.utils';
import { prisma } from '../../utils/prisma.utils';
import {
   isSafeProofUrl,
   parsePublicHttpsUrl,
   ProofCheckService,
   proofCheckService,
} from './proof-check.service';
import {
   MAX_PROOF_LINKS,
   MAX_PROOF_URL_LENGTH,
   PROOF_CODE_PREFIX,
   ProofProvider,
   VERIFICATION_TRANSITIONS,
   VerificationStatus,
} from './verification.constants';

export class CreatorProfileMissingError extends Error {
   constructor() {
      super('A creator profile is required before applying for verification');
      this.name = 'CreatorProfileMissingError';
   }
}

export class ApplicationNotFoundError extends Error {
   constructor() {
      super('Verification application not found');
      this.name = 'ApplicationNotFoundError';
   }
}

export class VerificationConflictError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'VerificationConflictError';
   }
}

export class InvalidProofLinkError extends Error {
   constructor(
      message: string,
      public readonly field: string
   ) {
      super(message);
      this.name = 'InvalidProofLinkError';
   }
}

export interface ProofLinkInput {
   provider: ProofProvider;
   url: string;
}

export interface VerificationProofView {
   id: string;
   provider: string;
   url: string;
   status: string;
   failureReason: string | null;
   checkedAt: string | null;
}

export interface VerificationApplicationView {
   id: string;
   creatorId: string;
   status: string;
   proofCode: string;
   reviewerId: string | null;
   decisionNote: string | null;
   submittedAt: string;
   decidedAt: string | null;
   proofs: VerificationProofView[];
}

export interface VerificationDecisionView {
   status: string;
   reviewerId: string;
   note: string;
   createdAt: string;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/**
 * Keyed hash of the normalized legal name. The name is never stored, but the
 * hash still lets reviewers spot a name used on several applications.
 */
export function hashLegalName(legalName: string): string {
   const normalized = legalName.trim().replace(/\s+/g, ' ').toLowerCase();
   return createHmac('sha256', envConfig.JWT_SECRET)
      .update(`verification-legal-name:${normalized}`)
      .digest('hex');
}

/** A unique, human-typeable code, e.g. AL-VERIFY-3F9A2C71B0D4. */
export function createProofCode(): string {
   return `${PROOF_CODE_PREFIX}${randomBytes(6).toString('hex').toUpperCase()}`;
}

/** Checks the links and returns them normalized. Throws on the first invalid one. */
export function validateProofLinks(links: ProofLinkInput[]): ProofLinkInput[] {
   if (links.length === 0 || links.length > MAX_PROOF_LINKS) {
      throw new InvalidProofLinkError(
         `Provide between 1 and ${MAX_PROOF_LINKS} linked accounts`,
         'links'
      );
   }
   return links.map((link, index) => {
      const field = `links.${index}.url`;
      if (link.url.length > MAX_PROOF_URL_LENGTH) {
         throw new InvalidProofLinkError('Link is too long', field);
      }
      if (!parsePublicHttpsUrl(link.url) || !isSafeProofUrl(link.provider, link.url)) {
         throw new InvalidProofLinkError(
            `Link must be a public HTTPS page on ${link.provider === 'website' ? 'your website' : link.provider}`,
            field
         );
      }
      return { provider: link.provider, url: new URL(link.url).toString() };
   });
}

function toProofView(row: {
   id: string;
   provider: string;
   url: string;
   status: string;
   failureReason: string | null;
   checkedAt: Date | null;
}): VerificationProofView {
   return {
      id: row.id,
      provider: row.provider,
      url: row.url,
      status: row.status,
      failureReason: row.failureReason,
      checkedAt: iso(row.checkedAt),
   };
}

function toApplicationView(row: {
   id: string;
   creatorId: string;
   status: string;
   proofCode: string;
   reviewerId: string | null;
   decisionNote: string | null;
   submittedAt: Date;
   decidedAt: Date | null;
   proofs: Parameters<typeof toProofView>[0][];
}): VerificationApplicationView {
   return {
      id: row.id,
      creatorId: row.creatorId,
      status: row.status,
      proofCode: row.proofCode,
      reviewerId: row.reviewerId,
      decisionNote: row.decisionNote,
      submittedAt: row.submittedAt.toISOString(),
      decidedAt: iso(row.decidedAt),
      proofs: row.proofs.map(toProofView),
   };
}

const PROOF_SELECT = {
   id: true,
   provider: true,
   url: true,
   status: true,
   failureReason: true,
   checkedAt: true,
} as const;

// ── Creator operations ──────────────────────────────────────

/** Files an application for the caller's creator profile. */
export async function submitVerificationApplication(
   userId: string,
   input: { legalName: string; links: ProofLinkInput[] },
   now: Date = new Date()
): Promise<VerificationApplicationView> {
   const profile = await prisma.creatorProfile.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, isVerified: true },
   });
   if (!profile) throw new CreatorProfileMissingError();
   if (profile.isVerified) {
      throw new VerificationConflictError('This creator is already verified');
   }

   const open = await prisma.verificationApplication.findFirst({
      where: { creatorId: profile.id, status: { in: ['submitted', 'in_review'] } },
      select: { id: true },
   });
   if (open) {
      throw new VerificationConflictError('An application is already under review');
   }

   const links = validateProofLinks(input.links);
   const row = await prisma.verificationApplication.create({
      data: {
         creatorId: profile.id,
         status: 'submitted',
         legalNameHash: hashLegalName(input.legalName),
         proofCode: createProofCode(),
         submittedAt: now,
         proofs: {
            create: links.map(link => ({ provider: link.provider, url: link.url })),
         },
      },
      include: { proofs: { select: PROOF_SELECT, orderBy: { createdAt: 'asc' } } },
   });
   return toApplicationView(row);
}

/** The caller's most recent application, or null. */
export async function getLatestVerificationApplication(
   userId: string
): Promise<VerificationApplicationView | null> {
   const profile = await prisma.creatorProfile.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
   });
   if (!profile) throw new CreatorProfileMissingError();

   const row = await prisma.verificationApplication.findFirst({
      where: { creatorId: profile.id },
      orderBy: { createdAt: 'desc' },
      include: { proofs: { select: PROOF_SELECT, orderBy: { createdAt: 'asc' } } },
   });
   return row ? toApplicationView(row) : null;
}

// ── Reviewer operations ─────────────────────────────────────

export async function listVerificationApplications(params: {
   page: number;
   limit: number;
   status?: VerificationStatus;
}): Promise<{ data: VerificationApplicationView[]; meta: PaginationMetadata }> {
   const where = params.status ? { status: params.status } : {};
   const [rows, totalCount] = await prisma.$transaction([
      prisma.verificationApplication.findMany({
         where,
         orderBy: { submittedAt: 'asc' },
         skip: (params.page - 1) * params.limit,
         take: params.limit,
         include: { proofs: { select: PROOF_SELECT, orderBy: { createdAt: 'asc' } } },
      }),
      prisma.verificationApplication.count({ where }),
   ]);
   const totalPages = Math.max(1, Math.ceil(totalCount / params.limit));
   return {
      data: rows.map(toApplicationView),
      meta: {
         page: params.page,
         limit: params.limit,
         totalCount,
         totalPages,
         hasNextPage: params.page < totalPages,
         hasPrevPage: params.page > 1,
      },
   };
}

/** One application with its proofs and full decision history. */
export async function getVerificationApplication(applicationId: string): Promise<
   VerificationApplicationView & { decisions: VerificationDecisionView[] }
> {
   const row = await prisma.verificationApplication.findUnique({
      where: { id: applicationId },
      include: {
         proofs: { select: PROOF_SELECT, orderBy: { createdAt: 'asc' } },
         decisions: { orderBy: { createdAt: 'asc' } },
      },
   });
   if (!row) throw new ApplicationNotFoundError();
   return {
      ...toApplicationView(row),
      decisions: row.decisions.map(decision => ({
         status: decision.status,
         reviewerId: decision.reviewerId,
         note: decision.note,
         createdAt: decision.createdAt.toISOString(),
      })),
   };
}

/** Moves an application to `in_review` and assigns it to the reviewer. */
export async function claimVerificationApplication(
   applicationId: string,
   reviewerId: string,
   now: Date = new Date()
): Promise<VerificationApplicationView> {
   const current = await prisma.verificationApplication.findUnique({
      where: { id: applicationId },
      select: { status: true },
   });
   if (!current) throw new ApplicationNotFoundError();
   if (!VERIFICATION_TRANSITIONS[current.status as VerificationStatus].includes('in_review')) {
      throw new VerificationConflictError(`An application in ${current.status} cannot be claimed`);
   }

   await prisma.$transaction(async tx => {
      const claimed = await tx.verificationApplication.updateMany({
         where: { id: applicationId, status: 'submitted' },
         data: { status: 'in_review', reviewerId, reviewedAt: now },
      });
      if (claimed.count === 0) {
         throw new VerificationConflictError('This application was claimed by someone else');
      }
      await tx.verificationDecision.create({
         data: { applicationId, status: 'in_review', reviewerId, note: 'Claimed for review', createdAt: now },
      });
   });

   return loadApplicationView(applicationId);
}

/**
 * Runs the proof check and stores each link's result. Repeating it replaces the
 * earlier results. Only an application still open for review can be checked.
 */
export async function runVerificationProofCheck(
   applicationId: string,
   checker: ProofCheckService = proofCheckService,
   now: Date = new Date()
): Promise<{ passed: boolean; proofs: VerificationProofView[] }> {
   const application = await prisma.verificationApplication.findUnique({
      where: { id: applicationId },
      include: { proofs: { select: { id: true, provider: true, url: true }, orderBy: { createdAt: 'asc' } } },
   });
   if (!application) throw new ApplicationNotFoundError();
   if (application.status !== 'submitted' && application.status !== 'in_review') {
      throw new VerificationConflictError(`Proof checks cannot run on an application in ${application.status}`);
   }

   const outcome = await checker.verify({
      proofCode: application.proofCode,
      proofs: application.proofs.map(proof => ({
         id: proof.id,
         provider: proof.provider as ProofProvider,
         url: proof.url,
      })),
   });

   await prisma.$transaction(
      outcome.results.map(result =>
         prisma.verificationProof.update({
            where: { id: result.proofId },
            data: {
               status: result.passed ? 'passed' : 'failed',
               failureReason: result.failureReason,
               checkedAt: now,
            },
         })
      )
   );

   const refreshed = await loadApplicationView(applicationId);
   return { passed: outcome.passed, proofs: refreshed.proofs };
}

/**
 * Approves or rejects a claimed application. Approval requires every linked
 * account to have passed the proof check. Approval also sets the creator's
 * verified flag and `verifiedAt`, in the same transaction as the decision.
 */
export async function decideVerificationApplication(
   applicationId: string,
   reviewerId: string,
   input: { decision: 'approved' | 'rejected'; note: string },
   now: Date = new Date()
): Promise<VerificationApplicationView> {
   const application = await prisma.verificationApplication.findUnique({
      where: { id: applicationId },
      include: { proofs: { select: { status: true } } },
   });
   if (!application) throw new ApplicationNotFoundError();

   const from = application.status as VerificationStatus;
   if (!VERIFICATION_TRANSITIONS[from].includes(input.decision)) {
      throw new VerificationConflictError(`An application in ${from} cannot be ${input.decision}`);
   }
   if (application.reviewerId !== reviewerId) {
      throw new VerificationConflictError('Only the reviewer who claimed this application can decide it');
   }
   if (input.decision === 'approved') {
      const allPassed =
         application.proofs.length > 0 && application.proofs.every(proof => proof.status === 'passed');
      if (!allPassed) {
         throw new VerificationConflictError(
            'Every linked account must pass the proof check before approval'
         );
      }
   }

   await prisma.$transaction(async tx => {
      const updated = await tx.verificationApplication.updateMany({
         where: { id: applicationId, status: 'in_review', reviewerId },
         data: {
            status: input.decision,
            decisionNote: input.note,
            decidedAt: now,
         },
      });
      if (updated.count === 0) {
         throw new VerificationConflictError('This application changed while it was being decided');
      }
      await tx.verificationDecision.create({
         data: {
            applicationId,
            status: input.decision,
            reviewerId,
            note: input.note,
            createdAt: now,
         },
      });
      if (input.decision === 'approved') {
         await tx.creatorProfile.update({
            where: { id: application.creatorId },
            data: { isVerified: true, verifiedAt: now },
         });
      }
   });

   return loadApplicationView(applicationId);
}

async function loadApplicationView(applicationId: string): Promise<VerificationApplicationView> {
   const row = await prisma.verificationApplication.findUnique({
      where: { id: applicationId },
      include: { proofs: { select: PROOF_SELECT, orderBy: { createdAt: 'asc' } } },
   });
   if (!row) throw new ApplicationNotFoundError();
   return toApplicationView(row);
}
