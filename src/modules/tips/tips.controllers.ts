import { AsyncController } from '../../types/auth.types';
import { sendSuccess } from '../../utils/api-response.utils';
import { getTipMessageContent } from './tips.service';

export const httpGetTipContent: AsyncController = async (req, res, next) => {
   const keyId = Array.isArray(req.params.key_id) ? req.params.key_id[0] : req.params.key_id;
   const tipId = Array.isArray(req.params.tip_id) ? req.params.tip_id[0] : req.params.tip_id;
   if (typeof tipId !== 'string' || !tipId.trim()) {
      res.status(400).json({
         success: false,
         error: {
            code: 'INVALID_TIP_ID',
            message: 'A valid tip_id is required',
         },
      });
      return;
   }

   try {
      const content = await getTipMessageContent(keyId, tipId);
      if (!content) {
         res.status(404).json({
            success: false,
            error: {
               code: 'TIP_NOT_FOUND',
               message: 'Tip not found or has no message',
            },
         });
         return;
      }
      sendSuccess(res, content);
   } catch (error) {
      next(error);
   }
};
