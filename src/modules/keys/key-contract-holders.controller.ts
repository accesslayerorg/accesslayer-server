// src/modules/keys/key-contract-holders.controller.ts
// GET /api/v1/keys/:keyId/contract-holders (#1274)
import type { AsyncController } from '../../types/auth.types';
import {
  sendNotFound,
  sendSuccess,
} from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { prisma } from '../../utils/prisma.utils';
import { isContractAddress } from '../contracts/callback-transfer.service';
import {
  resolveKey,
  HolderLeaderboardKeyNotFoundError,
} from './key-holder-leaderboard.service';

/**
 * GET /api/v1/keys/:keyId/contract-holders (#1274)
 *
 * Every holder of the key that is a Stellar contract, with balance —
 * the "contract holders" of the issue. Each entry carries `isContract`
 * (a holder address that is not a wallet/account).
 */
export const httpGetKeyContractHolders: AsyncController = async (
  req,
  res,
  next
) => {
  try {
    const keyId = String(req.params.keyId || '');
    await resolveKey(keyId); // 404 when the key does not exist

    const rows = await prisma.keyOwnership.findMany({
      where: { creatorId: keyId, balance: { gt: 0 } },
      orderBy: { balance: 'desc' },
      select: { ownerAddress: true, balance: true, createdAt: true },
    });

    attachTimestampHeader(res);
    sendSuccess(res, {
      keyId,
      totalHolders: rows.length,
      items: rows.map(r => ({
        wallet_address: r.ownerAddress,
        balance: Number(r.balance),
        isContract: isContractAddress(r.ownerAddress),
        since: r.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    if (error instanceof HolderLeaderboardKeyNotFoundError) {
      sendNotFound(res, 'Key');
      return;
    }
    next(error);
  }
};
