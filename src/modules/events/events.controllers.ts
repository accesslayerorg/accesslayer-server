// src/modules/events/events.controllers.ts
// Merkle-proof event integrity controller (#727)

import { Request, Response } from 'express';
import { getEventInclusionProof } from './events.service';
import { logger } from '../../utils/logger.utils';

/**
 * GET /events/:eventId/proof
 * Returns a JSON inclusion proof:
 * {
 *   leafHash: string,
 *   leafIndex: number,
 *   treeSize: number,
 *   root: string,
 *   siblings: Array<{ hash: string, side: 'left' | 'right' }>,
 *   partitionId: string,
 *   sorobanTxHash: string | null
 * }
 * Returns 404 if the event does not exist or has not yet been included in a closed partition.
 */
export async function getEventProofController(
   req: Request,
   res: Response
): Promise<void> {
   const { eventId } = req.params;

   if (!eventId || typeof eventId !== 'string') {
      res.status(400).json({
         success: false,
         error: 'Invalid or missing eventId parameter',
      });
      return;
   }

   try {
      const proof = await getEventInclusionProof(eventId);

      if (!proof) {
         res.status(404).json({
            success: false,
            error: 'Proof not available: event not found or partition is open',
         });
         return;
      }

      res.status(200).json({
         leafHash: proof.leafHash,
         leafIndex: proof.leafIndex,
         treeSize: proof.treeSize,
         root: proof.root,
         siblings: proof.siblings,
         partitionId: proof.partitionId,
         sorobanTxHash: proof.sorobanTxHash,
      });
   } catch (error: any) {
      logger.error({ eventId, error: error?.message }, 'Failed to get event inclusion proof');
      res.status(500).json({
         success: false,
         error: 'Internal server error fetching inclusion proof',
      });
   }
}
