// src/indexer/event-processor.ts
// Processes indexed contract events; persists BondForfeited into forfeiture history.

import { prisma } from '../utils/prisma.utils';
import { logger } from '../utils/logger.utils';

export interface BondForfeitedEvent {
   keyId: string;
   amount: string;
   reason: string;
   txHash: string;
   ledgerTimestamp: Date;
}

/**
 * Handles a decoded BondForfeited contract event. Idempotent on txHash so
 * re-processing a ledger does not duplicate forfeiture records.
 */
export async function handleBondForfeited(event: BondForfeitedEvent): Promise<void> {
   if (!event.txHash) {
      throw new Error('BondForfeited event missing txHash');
   }

   await prisma.bondForfeiture.upsert({
      where: { txHash: event.txHash },
      create: {
         keyId: event.keyId,
         amount: event.amount,
         reason: event.reason,
         timestamp: event.ledgerTimestamp,
         txHash: event.txHash,
      },
      update: {},
   });

   logger.info(
      { keyId: event.keyId, txHash: event.txHash },
      'Indexed BondForfeited event'
   );
}
