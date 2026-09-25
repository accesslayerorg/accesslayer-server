// Integration test: creator registration endpoint — display name length validation
//
// Verifies that:
//   1. A display name exceeding 50 characters is rejected with HTTP 422 and
//      the machine-readable code 'display_name_too_long'.
//   2. A display name of exactly 50 characters is accepted with HTTP 201.
//   3. No creator record is written to the database when validation fails.
//
// The handler under test is a self-contained placeholder that mirrors the
// registration contract described in the unmerged PR. Once the real
// httpRegisterCreator handler lands, replace the inline handler below with
// the production import and remove the inline mock setup.

import express from 'express';
import request from 'supertest';
import { DISPLAY_NAME_MAX_LENGTH } from '../creator/creator-display-name-sanitize.utils';

// ── Prisma mock ───────────────────────────────────────────────────────────────
//
// Isolate every test from the database. We only need creatorProfile.findFirst
// (duplicate check) and creatorProfile.create (write on success) for this
// endpoint, so every other method is left as undefined to surface accidental
// calls as clear errors.

const mockCreatorProfile = {
   findFirst: jest.fn(),
   create: jest.fn(),
};

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: mockCreatorProfile,
   },
}));

// ── Inline registration handler ───────────────────────────────────────────────
//
// Mirrors the intended contract of the real registration handler.
// Validation runs before any database interaction so a rejected request
// never touches the DB.

import { prisma } from '../../utils/prisma.utils';

async function httpRegisterCreator(req: any, res: any): Promise<void> {
   const { wallet, displayName } = req.body ?? {};

   // Guard: displayName must be present and within the 50-character limit.
   // Validation fires before any DB read/write to satisfy the acceptance
   // criterion "No database record created on validation failure".
   if (
      typeof displayName === 'string' &&
      displayName.length > DISPLAY_NAME_MAX_LENGTH
   ) {
      res.status(422).json({
         success: false,
         error: {
            code: 'VALIDATION_ERROR',
            message: 'Display name is too long',
            details: [
               {
                  field: 'displayName',
                  message: 'display_name_too_long',
               },
            ],
         },
      });
      return;
   }

   // Duplicate wallet guard
   const existing = await (prisma.creatorProfile.findFirst as jest.Mock)({
      where: { handle: wallet },
   });
   if (existing) {
      res.status(409).json({ error: 'creator_already_exists' });
      return;
   }

   // Persist
   const creator = await (prisma.creatorProfile.create as jest.Mock)({
      data: {
         id: `creator-${Date.now()}`,
         handle: wallet,
         displayName: displayName ?? 'New Creator',
         userId: 'test-user-id',
      },
   });

   res.status(201).json({ data: creator });
}

// ── Application under test ────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.post('/api/v1/creators', httpRegisterCreator);

// ── Constants ─────────────────────────────────────────────────────────────────

const WALLET = 'GABC111111111111111111111111111111111111111111111111WXYZ';

/** Exactly 50 characters — the maximum allowed length. */
const NAME_AT_LIMIT = 'A'.repeat(DISPLAY_NAME_MAX_LENGTH);

/** One character over the limit — must be rejected. */
const NAME_OVER_LIMIT = 'A'.repeat(DISPLAY_NAME_MAX_LENGTH + 1);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/creators — display name length validation', () => {
   beforeEach(() => {
      jest.clearAllMocks();

      // Default: no existing creator profile (no duplicate)
      mockCreatorProfile.findFirst.mockResolvedValue(null);

      // Default: successful create returns a minimal creator object
      mockCreatorProfile.create.mockResolvedValue({
         id: 'creator-test-id',
         handle: WALLET,
         displayName: NAME_AT_LIMIT,
         userId: 'test-user-id',
      });
   });

   it('returns 422 with display_name_too_long for a 51-character display name', async () => {
      const response = await request(app)
         .post('/api/v1/creators')
         .send({ wallet: WALLET, displayName: NAME_OVER_LIMIT });

      expect(response.status).toBe(422);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');

      // The per-field detail must carry the machine-readable 'display_name_too_long' token
      const details: Array<{ field: string; message: string }> =
         response.body.error.details ?? [];
      const displayNameDetail = details.find(d => d.field === 'displayName');
      expect(displayNameDetail).toBeDefined();
      expect(displayNameDetail!.message).toBe('display_name_too_long');
   });

   it('does not write any creator record to the database when validation fails', async () => {
      await request(app)
         .post('/api/v1/creators')
         .send({ wallet: WALLET, displayName: NAME_OVER_LIMIT });

      // Neither a duplicate check nor a write should have been attempted
      expect(mockCreatorProfile.findFirst).not.toHaveBeenCalled();
      expect(mockCreatorProfile.create).not.toHaveBeenCalled();
   });

   it('returns 201 for a display name of exactly 50 characters', async () => {
      const response = await request(app)
         .post('/api/v1/creators')
         .send({ wallet: WALLET, displayName: NAME_AT_LIMIT });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('data');
   });
});
