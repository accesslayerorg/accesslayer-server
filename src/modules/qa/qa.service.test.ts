// src/modules/qa/qa.service.test.ts

jest.mock('../../utils/prisma.utils', () => {
   const mockTx = {
      qaVote: { create: jest.fn() },
      qaQuestion: { update: jest.fn() },
   };
   return {
      prisma: {
         creatorProfile: { findFirst: jest.fn() },
         stellarWallet: { findUnique: jest.fn() },
         qaSession: { create: jest.fn(), findUnique: jest.fn() },
         qaQuestion: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
         },
         qaVote: { findUnique: jest.fn() },
         keyOwnership: { findFirst: jest.fn() },
         $transaction: jest.fn(async (cb: any) => cb(mockTx)),
         __mockTx: mockTx,
      },
   };
});

import { prisma } from '../../utils/prisma.utils';
import {
   scheduleQaSession,
   getQaSession,
   submitQaQuestion,
   voteQaQuestion,
   answerQaQuestion,
} from './qa.service';

const mockPrisma = prisma as any;
const mockTx = mockPrisma.__mockTx;

describe('qa.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({
         id: 'key-1',
         userId: 'user-creator',
      });
      mockPrisma.stellarWallet.findUnique.mockResolvedValue({
         userId: 'user-creator',
      });
   });

   it('schedules a Q&A session for the key creator', async () => {
      mockPrisma.qaSession.create.mockResolvedValue({
         id: 'qa-1',
         keyId: 'key-1',
         title: 'Monthly AMA',
         durationMinutes: 60,
         minBalance: 5,
      });

      const session = await scheduleQaSession({
         keyId: 'key-1',
         creatorWallet: 'GCREATOR',
         title: 'Monthly AMA',
         startsAt: '2026-12-01T18:00:00Z',
         durationMinutes: 60,
         minBalance: 5,
      });

      expect(session.id).toBe('qa-1');
      expect(mockPrisma.qaSession.create).toHaveBeenCalled();
   });

   it('fetches Q&A session with questions sorted by votes and answered filter', async () => {
      mockPrisma.qaSession.findUnique.mockResolvedValue({ id: 'qa-1' });
      mockPrisma.qaQuestion.findMany.mockResolvedValue([
         { id: 'q-1', voteCount: 10, answered: false },
      ]);

      const result = await getQaSession('qa-1', false);
      expect(result.questions).toHaveLength(1);
      expect(mockPrisma.qaQuestion.findMany).toHaveBeenCalledWith({
         where: { sessionId: 'qa-1', answered: false },
         orderBy: [{ voteCount: 'desc' }, { createdAt: 'asc' }],
      });
   });

   it('enforces 200-char limit, eligible holder balance, and one open question per wallet', async () => {
      await expect(
         submitQaQuestion({
            sessionId: 'qa-1',
            authorWallet: 'GHOLDER',
            body: 'a'.repeat(201),
         })
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_QUESTION_LENGTH' });

      mockPrisma.qaSession.findUnique.mockResolvedValue({
         id: 'qa-1',
         keyId: 'key-1',
         minBalance: 10,
      });
      mockPrisma.keyOwnership.findFirst.mockResolvedValue({ balance: 2 });

      await expect(
         submitQaQuestion({
            sessionId: 'qa-1',
            authorWallet: 'GHOLDER',
            body: 'When staking?',
         })
      ).rejects.toMatchObject({ statusCode: 403, code: 'INELIGIBLE_HOLDER' });

      mockPrisma.keyOwnership.findFirst.mockResolvedValue({ balance: 15 });
      mockPrisma.qaQuestion.findFirst.mockResolvedValue({ id: 'existing-q' });

      await expect(
         submitQaQuestion({
            sessionId: 'qa-1',
            authorWallet: 'GHOLDER',
            body: 'When staking?',
         })
      ).rejects.toMatchObject({ statusCode: 409, code: 'OPEN_QUESTION_EXISTS' });

      mockPrisma.qaQuestion.findFirst.mockResolvedValue(null);
      mockPrisma.qaQuestion.create.mockResolvedValue({
         id: 'q-new',
         body: 'When staking?',
      });

      const created = await submitQaQuestion({
         sessionId: 'qa-1',
         authorWallet: 'GHOLDER',
         body: 'When staking?',
      });
      expect(created.id).toBe('q-new');
   });

   it('enforces one vote per wallet per question', async () => {
      mockPrisma.qaQuestion.findUnique.mockResolvedValue({ id: 'q-1' });
      mockPrisma.qaVote.findUnique.mockResolvedValue({ id: 'v-1' });

      await expect(
         voteQaQuestion({ questionId: 'q-1', walletAddress: 'GWALLET' })
      ).rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_VOTED' });

      mockPrisma.qaVote.findUnique.mockResolvedValue(null);
      mockTx.qaQuestion.update.mockResolvedValue({ id: 'q-1', voteCount: 1 });

      const updated = await voteQaQuestion({
         questionId: 'q-1',
         walletAddress: 'GWALLET',
      });
      expect(updated.voteCount).toBe(1);
   });

   it('allows only creator to answer a question', async () => {
      mockPrisma.qaQuestion.findUnique.mockResolvedValue({
         id: 'q-1',
         session: { keyId: 'key-1' },
      });
      mockPrisma.stellarWallet.findUnique.mockResolvedValue({
         userId: 'other-user',
      });

      await expect(
         answerQaQuestion({
            questionId: 'q-1',
            creatorWallet: 'GNOTCREATOR',
            answer: 'Soon!',
         })
      ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

      mockPrisma.stellarWallet.findUnique.mockResolvedValue({
         userId: 'user-creator',
      });
      mockPrisma.qaQuestion.update.mockResolvedValue({
         id: 'q-1',
         answered: true,
         answer: 'Next month!',
      });

      const answered = await answerQaQuestion({
         questionId: 'q-1',
         creatorWallet: 'GCREATOR',
         answer: 'Next month!',
      });
      expect(answered.answered).toBe(true);
   });
});
