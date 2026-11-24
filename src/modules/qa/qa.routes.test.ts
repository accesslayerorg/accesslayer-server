// src/modules/qa/qa.routes.test.ts

import express from 'express';
import request from 'supertest';

jest.mock('../../middlewares/jwt-auth.middleware', () => ({
   requireJwtAuth: (req: any, _res: any, next: any) => {
      req.user = { wallet: 'GWALLET1' };
      next();
   },
   requireKeyCreator: () => (req: any, _res: any, next: any) => {
      req.user = { wallet: 'GCREATOR1' };
      next();
   },
}));

jest.mock('./qa.service', () => {
   const actual = jest.requireActual('./qa.service');
   return {
      ...actual,
      scheduleQaSession: jest.fn(),
      getQaSession: jest.fn(),
      submitQaQuestion: jest.fn(),
      voteQaQuestion: jest.fn(),
      answerQaQuestion: jest.fn(),
   };
});

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import { keyQaRouter, qaRouter } from './qa.routes';
import {
   scheduleQaSession,
   getQaSession,
   submitQaQuestion,
   voteQaQuestion,
   answerQaQuestion,
} from './qa.service';

describe('qa.routes', () => {
   const app = express();
   app.use(express.json());
   app.use('/v1/keys', keyQaRouter);
   app.use('/v1/qa', qaRouter);

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('POST /v1/keys/:keyId/qa schedules a session', async () => {
      (scheduleQaSession as jest.Mock).mockResolvedValue({
         id: 'qa-1',
         title: 'AMA',
      });

      const res = await request(app)
         .post('/v1/keys/key-1/qa')
         .send({
            title: 'AMA',
            startsAt: '2026-12-01T18:00:00Z',
            durationMinutes: 45,
            minBalance: 1,
         });

      expect(res.status).toBe(201);
      expect(res.body.data.session.id).toBe('qa-1');
   });

   it('GET /v1/qa/:id returns session and questions', async () => {
      (getQaSession as jest.Mock).mockResolvedValue({
         session: { id: 'qa-1' },
         questions: [{ id: 'q-1', voteCount: 5 }],
      });

      const res = await request(app).get('/v1/qa/qa-1?answered=false');
      expect(res.status).toBe(200);
      expect(getQaSession).toHaveBeenCalledWith('qa-1', false);
   });

   it('POST /v1/qa/:id/questions submits a question', async () => {
      (submitQaQuestion as jest.Mock).mockResolvedValue({
         id: 'q-1',
         body: 'Roadmap update?',
      });

      const res = await request(app)
         .post('/v1/qa/qa-1/questions')
         .send({ body: 'Roadmap update?' });

      expect(res.status).toBe(201);
      expect(res.body.data.question.id).toBe('q-1');
   });

   it('POST /v1/qa/questions/:id/vote casts a vote', async () => {
      (voteQaQuestion as jest.Mock).mockResolvedValue({
         id: 'q-1',
         voteCount: 1,
      });

      const res = await request(app).post('/v1/qa/questions/q-1/vote');
      expect(res.status).toBe(200);
      expect(res.body.data.question.voteCount).toBe(1);
   });

   it('POST /v1/qa/questions/:id/answer marks question answered', async () => {
      (answerQaQuestion as jest.Mock).mockResolvedValue({
         id: 'q-1',
         answered: true,
         answer: 'Yes!',
      });

      const res = await request(app)
         .post('/v1/qa/questions/q-1/answer')
         .send({ answer: 'Yes!' });

      expect(res.status).toBe(200);
      expect(res.body.data.question.answered).toBe(true);
   });
});
