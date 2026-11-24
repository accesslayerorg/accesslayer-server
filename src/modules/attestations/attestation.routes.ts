import { Router } from 'express';
import { requireJwtAuth, AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import { sendError, sendSuccess } from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { attestationService } from '../../services/attestation.service';

const router = Router();

router.post('/', requireJwtAuth, async (req: AuthenticatedRequest, res) => {
   const { holder, keyId } = req.body ?? {};
   if (typeof holder !== 'string' || typeof keyId !== 'string' || holder !== req.user?.wallet) {
      sendError(res, 403, ErrorCode.FORBIDDEN, 'An attestation can only be requested for the authenticated wallet');
      return;
   }
   try {
      sendSuccess(res, await attestationService.sign({ holder, keyId }));
   } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to sign attestation';
      sendError(res, 422, ErrorCode.VALIDATION_ERROR, message);
   }
});

router.get('/keys', (_req, res) => sendSuccess(res, { keys: attestationService.keys() }));

export default router;
