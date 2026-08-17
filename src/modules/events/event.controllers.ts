// src/modules/events/event.controllers.ts
import { Request, Response } from 'express';
import { sendSuccess, sendNotFound } from '../../utils/api-response.utils';
import { generateInclusionProof } from '../indexer/merkle-tree.service';

/**
 * Controller for GET /events/:eventId/proof
 * Returns Merkle inclusion proof for a closed partition event.
 * Returns 404 if event is not found or if event belongs to an open/unpublished partition.
 */
export const httpGetEventProof = async (
   req: Request,
   res: Response
): Promise<void> => {
   try {
      const eventId = String(req.params.eventId);
      const proof = await generateInclusionProof(eventId);

      if (!proof) {
         sendNotFound(res, 'Event proof');
         return;
      }

      sendSuccess(res, proof);
   } catch (error) {
      console.error('Failed to generate inclusion proof:', error);
      res.status(500).json({
         success: false,
         error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to generate inclusion proof',
         },
      });
   }
};
