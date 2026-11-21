import { Router } from 'express';
import { z } from 'zod';
import { requireStellarSignature, StellarSignedRequest } from '../../middlewares/stellar-signature.middleware';
import { ErrorCode, sendError, sendNotFound, sendSuccess, sendValidationError, zodIssuesToDetails } from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import { AirdropIdSchema, AirdropProofQuerySchema, CreateAirdropSchema } from './airdrop.schemas';
import { AirdropRequestError, createAirdrop, getAirdropProof, listAirdropClaims } from './airdrop.service';

export const airdropAdminRouter = Router();
export const airdropRouter = Router();

airdropAdminRouter.post('/', requireStellarSignature(), async (req: StellarSignedRequest, res, next) => {
   const parsed = CreateAirdropSchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(res, 'Invalid airdrop allocation list', zodIssuesToDetails(parsed.error.issues));
      return;
   }
   if (!req.signatureVerified || !req.walletAddress) {
      sendError(res, 401, ErrorCode.UNAUTHORIZED, 'Creator signature required');
      return;
   }
   try {
      sendSuccess(res, await createAirdrop(parsed.data, req.walletAddress), 201);
   } catch (error) {
      if (error instanceof AirdropRequestError) {
         sendError(res, error.statusCode, error.statusCode === 403 ? ErrorCode.FORBIDDEN : ErrorCode.NOT_FOUND, error.message);
         return;
      }
      logger.error({ error }, 'Failed to create Merkle airdrop');
      next(error);
   }
});

airdropRouter.get('/:id/proof', async (req, res, next) => {
   const id = AirdropIdSchema.safeParse(req.params.id);
   const query = AirdropProofQuerySchema.safeParse(req.query);
   if (!id.success || !query.success) {
      sendValidationError(res, 'Invalid airdrop ID or recipient address');
      return;
   }
   try {
      const proof = await getAirdropProof(id.data, query.data.address);
      if (!proof) {
         sendNotFound(res, 'Airdrop allocation');
         return;
      }
      sendSuccess(res, proof);
   } catch (error) {
      logger.error({ error, airdropId: id.data }, 'Failed to fetch airdrop proof');
      next(error);
   }
});

const ClaimsQuerySchema = z.object({
   limit: z.coerce.number().int().min(1).max(100).default(25),
   cursor: z.string().regex(/^[0-9]{1,5}$/).transform(Number).optional(),
}).strict();

airdropRouter.get('/:id/claims', async (req, res, next) => {
   const id = AirdropIdSchema.safeParse(req.params.id);
   const query = ClaimsQuerySchema.safeParse(req.query);
   if (!id.success || !query.success) {
      sendValidationError(res, 'Invalid airdrop ID or pagination');
      return;
   }
   try {
      const claims = await listAirdropClaims(id.data, query.data.limit, query.data.cursor);
      if (!claims) {
         sendNotFound(res, 'Airdrop');
         return;
      }
      sendSuccess(res, claims);
   } catch (error) {
      logger.error({ error, airdropId: id.data }, 'Failed to fetch airdrop claims');
      next(error);
   }
});
