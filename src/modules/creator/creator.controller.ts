// src/modules/creator/creator.controller.ts
import { Request, Response } from 'express';
import { sendPaginatedSuccess, sendError, ErrorCode } from '../../utils/api-response.utils';
import { getPaginatedCreators } from './creator.service';
import { parseCreatorSortOptions } from './creator.utils';

export async function listCreators(req: Request, res: Response) {
   try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const sortBy = req.query.sortBy as string;
      const sortOrder = req.query.sortOrder as string;

      if (page < 1 || limit < 1) {
         return sendError(res, 400, ErrorCode.VALIDATION_ERROR, 'Invalid pagination parameters');
      }

      const sort = parseCreatorSortOptions(sortBy, sortOrder);
      
      const { creators, meta } = await getPaginatedCreators({
         page,
         limit,
         sort,
      });

      return sendPaginatedSuccess(res, creators, meta, 200, 'Creators retrieved successfully');
   } catch (error) {
      console.error('Error listing creators:', error);
      return sendError(res, 500, ErrorCode.INTERNAL_ERROR, 'Failed to retrieve creators');
   }
}
