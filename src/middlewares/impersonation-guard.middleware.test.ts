jest.mock('../utils/prisma.utils', () => ({
   prisma: {
      impersonationSession: {
         findUnique: jest.fn(),
         update: jest.fn(),
      },
   },
}));

jest.mock('../modules/admin/audit-log.service', () => ({
   createAuditEntry: jest.fn(),
}));

jest.mock('../modules/admin/impersonation.service', () => {
   const actual = jest.requireActual('../modules/admin/impersonation.service');
   return { ...actual, closeExpiredImpersonation: jest.fn() };
});

import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { envConfig } from '../config';
import { prisma } from '../utils/prisma.utils';
import { createAuditEntry } from '../modules/admin/audit-log.service';
import { closeExpiredImpersonation, isMfaFresh } from '../modules/admin/impersonation.service';
import {
   impersonationDenyReason,
   impersonationGuard,
   isSensitiveImpersonationPath,
} from './impersonation-guard.middleware';

const TARGET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SESSION_ID = 'session-1';
const findUnique = prisma.impersonationSession.findUnique as unknown as jest.Mock;
const update = prisma.impersonationSession.update as unknown as jest.Mock;

function signImpersonation(exp?: number, secret: string = envConfig.JWT_SECRET) {
   return jwt.sign(
      {
         wallet: TARGET,
         ...(exp !== undefined ? { exp } : {}),
         impersonation: { sessionId: SESSION_ID, adminId: 'admin-1', readOnly: true },
      },
      secret,
      { subject: TARGET, issuer: envConfig.JWT_ISSUER, jwtid: SESSION_ID, ...(exp === undefined ? { expiresIn: 900 } : {}) }
   );
}

function impersonationToken() {
   return signImpersonation();
}

function activeSession(overrides: Record<string, unknown> = {}) {
   return {
      id: SESSION_ID,
      adminId: 'admin-1',
      targetUserId: 'user-1',
      targetWallet: TARGET,
      reason: 'investigating a support ticket',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      endedAt: null,
      endReason: null,
      requestCount: 0,
      createdAt: new Date(),
      ...overrides,
   };
}

function buildApp() {
   const app = express();
   app.use(impersonationGuard);
   app.get('/v1/keys/:id', (_req, res) => res.json({ id: 'key' }));
   app.post('/v1/keys/:id', (_req, res) => res.json({ wrote: true }));
   app.get('/v1/admin/audit-log', (_req, res) => res.json({ ok: true }));
   return app;
}

describe('impersonation rules', () => {
   it('denies every non-read method', () => {
      expect(impersonationDenyReason('POST', '/v1/keys/1')).toBe(
         'Impersonation sessions are read-only'
      );
      expect(impersonationDenyReason('DELETE', '/v1/keys/1')).toBe(
         'Impersonation sessions are read-only'
      );
      expect(impersonationDenyReason('GET', '/v1/keys/1')).toBeNull();
      expect(impersonationDenyReason('HEAD', '/v1/keys/1')).toBeNull();
   });

   it('blocks sensitive route groups, with or without the version prefix', () => {
      expect(isSensitiveImpersonationPath('/api/v1/admin/audit-log')).toBe(true);
      expect(isSensitiveImpersonationPath('/v1/api-keys')).toBe(true);
      expect(isSensitiveImpersonationPath('/v1/export/creators')).toBe(true);
      expect(isSensitiveImpersonationPath('/v1/keys/123')).toBe(false);
      expect(isSensitiveImpersonationPath('/administration-notes')).toBe(false);
   });
});

describe('isMfaFresh', () => {
   const now = new Date('2026-11-24T12:00:00.000Z');
   const nowSeconds = Math.floor(now.getTime() / 1000);

   it('accepts a second factor verified within five minutes', () => {
      expect(isMfaFresh(nowSeconds - 60, now)).toBe(true);
   });

   it('rejects a stale, missing, or far-future second factor', () => {
      expect(isMfaFresh(nowSeconds - 600, now)).toBe(false);
      expect(isMfaFresh(undefined, now)).toBe(false);
      expect(isMfaFresh(nowSeconds + 3600, now)).toBe(false);
   });
});

describe('impersonationGuard', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      update.mockResolvedValue({});
   });

   it('passes requests without an impersonation token through untouched', async () => {
      const res = await request(buildApp()).get('/v1/keys/1');

      expect(res.status).toBe(200);
      expect(res.headers['x-impersonated-by']).toBeUndefined();
      expect(findUnique).not.toHaveBeenCalled();
   });

   it('serves reads under an active session and marks the response', async () => {
      findUnique.mockResolvedValue(activeSession());

      const res = await request(buildApp())
         .get('/v1/keys/1')
         .set('Authorization', `Bearer ${impersonationToken()}`);

      expect(res.status).toBe(200);
      expect(res.headers['x-impersonated-by']).toBe('admin');
      expect(createAuditEntry).toHaveBeenCalledWith(
         expect.objectContaining({
            actionType: 'impersonation_request',
            payload: expect.objectContaining({ method: 'GET', allowed: true }),
         })
      );
    });

   it('rejects writes with 403 and audits the denied attempt', async () => {
      findUnique.mockResolvedValue(activeSession());

      const res = await request(buildApp())
         .post('/v1/keys/1')
         .set('Authorization', `Bearer ${impersonationToken()}`)
         .send({});

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(createAuditEntry).toHaveBeenCalledWith(
         expect.objectContaining({
            payload: expect.objectContaining({ allowed: false, method: 'POST' }),
         })
      );
   });

   it('rejects sensitive routes even for reads', async () => {
      findUnique.mockResolvedValue(activeSession());

      const res = await request(buildApp())
         .get('/v1/admin/audit-log')
         .set('Authorization', `Bearer ${impersonationToken()}`);

      expect(res.status).toBe(403);
   });

   it('rejects a session that an admin has ended', async () => {
      findUnique.mockResolvedValue(
         activeSession({ endedAt: new Date(), endReason: 'ADMIN_ENDED' })
      );

      const res = await request(buildApp())
         .get('/v1/keys/1')
         .set('Authorization', `Bearer ${impersonationToken()}`);

      expect(res.status).toBe(401);
   });

   it('rejects a session whose row has expired even if the token has not', async () => {
      findUnique.mockResolvedValue(
         activeSession({ expiresAt: new Date(Date.now() - 1000) })
      );

      const res = await request(buildApp())
         .get('/v1/keys/1')
         .set('Authorization', `Bearer ${impersonationToken()}`);

      expect(res.status).toBe(401);
   });

   it('closes the session and passes an expired token on to normal auth', async () => {
      const expired = signImpersonation(Math.floor(Date.now() / 1000) - 60);

      const res = await request(buildApp())
         .get('/v1/keys/1')
         .set('Authorization', `Bearer ${expired}`);

      expect(closeExpiredImpersonation).toHaveBeenCalledWith(SESSION_ID);
      // The bare test app has no JWT guard, so the request is served here.
      // In the real app requireJwtAuth rejects the expired token with 401.
      expect(res.status).toBe(200);
   });

   it('treats a token with a bad signature as not an impersonation token', async () => {
      const forged = signImpersonation(undefined, 'not-the-server-secret');

      const res = await request(buildApp())
         .get('/v1/keys/1')
         .set('Authorization', `Bearer ${forged}`);

      expect(findUnique).not.toHaveBeenCalled();
      expect(closeExpiredImpersonation).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
   });
});
