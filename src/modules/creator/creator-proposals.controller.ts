// src/modules/creator/creator-proposals.controller.ts
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import { sendNotFound, sendSuccess } from '../../utils/api-response.utils';
import {
   createCreatorProposal,
   KeyNotFoundError,
} from './creator-proposals.service';
import { CreateProposalInput } from './creator-proposals.schemas';

export async function httpCreateCreatorProposal(
   req: AuthenticatedRequest,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const keyId = Array.isArray(req.params.keyId)
         ? req.params.keyId[0]
         : req.params.keyId;
      const creatorWallet = req.user?.wallet || 'unknown';
      const input = req.body as CreateProposalInput;

      const proposal = await createCreatorProposal(keyId, creatorWallet, input);

      sendSuccess(
         res,
         {
            proposalId: proposal.proposalId,
            keyId: proposal.keyId,
            title: proposal.title,
            options: proposal.options,
            totalVotingWeight: proposal.totalVotingWeight,
            results: proposal.results,
            snapshotLedger: proposal.snapshotLedger,
            expiresAt: proposal.expiresAt.toISOString(),
            status: proposal.status,
            createdAt: proposal.createdAt.toISOString(),
         },
         201
      );
   } catch (error) {
      if (error instanceof KeyNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      next(error);
   }
}
