// src/modules/qa/qa.service.ts
// Holder Q&A sessions, eligible-holder question submission, voting, and creator answers (#1311).

import { prisma } from '../../utils/prisma.utils';

export const MAX_QUESTION_LENGTH = 200;

export class QaServiceError extends Error {
   statusCode: number;
   code: string;

   constructor(statusCode: number, code: string, message: string) {
      super(message);
      this.name = 'QaServiceError';
      this.statusCode = statusCode;
      this.code = code;
   }
}

async function resolveKeyId(keyIdOrHandle: string): Promise<string> {
   const profile = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyIdOrHandle }, { handle: keyIdOrHandle }] },
      select: { id: true },
   });
   return profile?.id ?? keyIdOrHandle;
}

async function assertKeyCreator(keyId: string, walletAddress: string): Promise<void> {
   const [profile, wallet] = await Promise.all([
      prisma.creatorProfile.findFirst({
         where: { OR: [{ id: keyId }, { handle: keyId }] },
         select: { userId: true },
      }),
      prisma.stellarWallet.findUnique({
         where: { address: walletAddress },
         select: { userId: true },
      }),
   ]);

   if (!profile) {
      throw new QaServiceError(404, 'KEY_NOT_FOUND', 'Creator key not found');
   }
   if (!wallet || wallet.userId !== profile.userId) {
      throw new QaServiceError(
         403,
         'FORBIDDEN',
         'Only the key creator can perform this action'
      );
   }
}

/**
 * Schedules a new holder Q&A session for a key.
 */
export async function scheduleQaSession(input: {
   keyId: string;
   creatorWallet: string;
   title: string;
   description?: string;
   startsAt: string;
   durationMinutes: number;
   minBalance: number;
}) {
   const keyId = await resolveKeyId(input.keyId);
   await assertKeyCreator(keyId, input.creatorWallet);

   return prisma.qaSession.create({
      data: {
         keyId,
         creatorWallet: input.creatorWallet,
         title: input.title,
         description: input.description ?? null,
         startsAt: new Date(input.startsAt),
         durationMinutes: input.durationMinutes,
         minBalance: input.minBalance,
      },
   });
}

/**
 * Returns a Q&A session and its questions sorted by vote count descending,
 * optionally filtered by `answered`.
 */
export async function getQaSession(
   sessionId: string,
   answered?: boolean
) {
   const session = await prisma.qaSession.findUnique({
      where: { id: sessionId },
   });
   if (!session) {
      throw new QaServiceError(
         404,
         'QA_SESSION_NOT_FOUND',
         'Q&A session not found'
      );
   }

   const questions = await prisma.qaQuestion.findMany({
      where: {
         sessionId,
         ...(answered !== undefined ? { answered } : {}),
      },
      orderBy: [{ voteCount: 'desc' }, { createdAt: 'asc' }],
   });

   return {
      session,
      questions,
   };
}

/**
 * Submits a question to a Q&A session, enforcing:
 * - 200-character limit
 * - holder balance >= session.minBalance
 * - at most one open (unanswered) question per wallet in the session
 */
export async function submitQaQuestion(input: {
   sessionId: string;
   authorWallet: string;
   body: string;
}) {
   const trimmed = input.body.trim();
   if (!trimmed || trimmed.length > MAX_QUESTION_LENGTH) {
      throw new QaServiceError(
         400,
         'INVALID_QUESTION_LENGTH',
         `Question must be between 1 and ${MAX_QUESTION_LENGTH} characters`
      );
   }

   const session = await prisma.qaSession.findUnique({
      where: { id: input.sessionId },
   });
   if (!session) {
      throw new QaServiceError(
         404,
         'QA_SESSION_NOT_FOUND',
         'Q&A session not found'
      );
   }

   const holding = await prisma.keyOwnership.findFirst({
      where: {
         ownerAddress: input.authorWallet,
         creatorId: session.keyId,
      },
      select: { balance: true },
   });
   const balance = holding ? Number(holding.balance) : 0;
   const requiredBalance = Number(session.minBalance);

   if (balance < requiredBalance || balance <= 0) {
      throw new QaServiceError(
         403,
         'INELIGIBLE_HOLDER',
         `Wallet must hold at least ${requiredBalance} key(s) to ask a question`
      );
   }

   const existingOpen = await prisma.qaQuestion.findFirst({
      where: {
         sessionId: input.sessionId,
         authorWallet: input.authorWallet,
         answered: false,
      },
      select: { id: true },
   });
   if (existingOpen) {
      throw new QaServiceError(
         409,
         'OPEN_QUESTION_EXISTS',
         'Each wallet may only have one open question per Q&A session'
      );
   }

   return prisma.qaQuestion.create({
      data: {
         sessionId: input.sessionId,
         authorWallet: input.authorWallet,
         body: trimmed,
      },
   });
}

/**
 * Casts a vote on a Q&A question, enforcing one vote per wallet per question.
 */
export async function voteQaQuestion(input: {
   questionId: string;
   walletAddress: string;
}) {
   const question = await prisma.qaQuestion.findUnique({
      where: { id: input.questionId },
      select: { id: true },
   });
   if (!question) {
      throw new QaServiceError(
         404,
         'QA_QUESTION_NOT_FOUND',
         'Q&A question not found'
      );
   }

   const existingVote = await prisma.qaVote.findUnique({
      where: {
         questionId_walletAddress: {
            questionId: input.questionId,
            walletAddress: input.walletAddress,
         },
      },
      select: { id: true },
   });
   if (existingVote) {
      throw new QaServiceError(
         409,
         'ALREADY_VOTED',
         'Wallet has already voted on this question'
      );
   }

   return prisma.$transaction(async tx => {
      await tx.qaVote.create({
         data: {
            questionId: input.questionId,
            walletAddress: input.walletAddress,
         },
      });

      return tx.qaQuestion.update({
         where: { id: input.questionId },
         data: { voteCount: { increment: 1 } },
      });
   });
}

/**
 * Creator-only action marking a question as answered.
 */
export async function answerQaQuestion(input: {
   questionId: string;
   creatorWallet: string;
   answer: string;
}) {
   const question = await prisma.qaQuestion.findUnique({
      where: { id: input.questionId },
      include: { session: { select: { keyId: true } } },
   });
   if (!question) {
      throw new QaServiceError(
         404,
         'QA_QUESTION_NOT_FOUND',
         'Q&A question not found'
      );
   }

   await assertKeyCreator(question.session.keyId, input.creatorWallet);

   return prisma.qaQuestion.update({
      where: { id: input.questionId },
      data: {
         answered: true,
         answer: input.answer.trim(),
         answeredAt: new Date(),
         answeredBy: input.creatorWallet,
      },
   });
}
