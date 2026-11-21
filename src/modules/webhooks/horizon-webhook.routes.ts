import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { envConfig } from '../../config';
import { sendError, sendSuccess } from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { prisma } from '../../utils/prisma.utils';
import { updateOwnership } from '../ownership/ownership.service';

const router = Router();

function hasValidSignature(payload: unknown, signature: string | undefined): boolean {
   if (!envConfig.HORIZON_WEBHOOK_SECRET || !signature) return false;
   const expected = createHmac('sha256', envConfig.HORIZON_WEBHOOK_SECRET)
      .update(JSON.stringify(payload))
      .digest('hex');
   if (signature.length !== expected.length) return false;
   return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

router.post('/horizon', async (req, res, next) => {
   const signature = req.header('x-horizon-signature');
   if (!hasValidSignature(req.body, signature)) {
      sendError(res, 401, ErrorCode.UNAUTHORIZED, 'Invalid Horizon webhook signature');
      return;
   }
   const event = req.body as {
      type?: string;
      memo?: string;
      transaction_hash?: string;
   };
   if (event.type !== 'payment_received' && event.type !== 'transaction_successful') {
      sendSuccess(res, { ignored: true });
      return;
   }
   if (!event.memo) {
      sendError(res, 400, ErrorCode.BAD_REQUEST, 'Horizon event memo is required');
      return;
   }
   try {
      const order = await prisma.pendingKeyPurchase.findUnique({ where: { memo: event.memo } });
      if (!order || order.status !== 'PENDING') {
         sendSuccess(res, { ignored: true });
         return;
      }
      await prisma.$transaction(async transaction => {
         await transaction.pendingKeyPurchase.update({
            where: { id: order.id },
            data: { status: 'SETTLED', transactionHash: event.transaction_hash, settledAt: new Date() },
         });
         await transaction.auditEvent.create({
            data: {
               actor: 'stellar-horizon',
               action: 'ownership_transferred',
               target: 'CreatorKey',
               targetId: order.creatorId,
               metadata: { purchaseId: order.id, transactionHash: event.transaction_hash },
            },
         });
      });
      await updateOwnership(order.buyerAddress, order.creatorId, Number(order.quantity));
      sendSuccess(res, { settled: true });
   } catch (error) {
      next(error);
   }
});

export default router;