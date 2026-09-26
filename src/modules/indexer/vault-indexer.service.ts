import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';

/**
 * Chain events emitted by the staking vault contract.
 */
export interface VaultChainEvent extends IndexerChainEvent {
   eventType: 'VAULT_DEPOSIT' | 'VAULT_WITHDRAW';
   wallet: string;
   /** Creator profile id of the deposited/withdrawn key. */
   creatorId: string;
   /** Quantity of keys moved, as a decimal string. */
   quantity: string;
}

/**
 * Applies VAULT_DEPOSIT / VAULT_WITHDRAW events to VaultPosition so the
 * database reflects the latest indexed contract state.
 *
 * Each event is recorded in VaultEventLog inside the same transaction as the
 * position change; a replayed event violates the (txHash, eventIndex) unique
 * constraint and is skipped, so quantities are never double-counted.
 * Withdrawals are clamped at zero.
 */
export async function processVaultEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (
         event.eventType !== 'VAULT_DEPOSIT' &&
         event.eventType !== 'VAULT_WITHDRAW'
      ) {
         return;
      }

      const { wallet, creatorId, quantity } = event as VaultChainEvent;
      const qty = Number(quantity);
      if (!wallet || !creatorId || !Number.isFinite(qty) || qty <= 0) {
         logger.warn(
            { eventId: `${event.txHash}:${event.eventIndex}` },
            'Skipping vault event with missing or invalid fields'
         );
         return;
      }

      const isDeposit = event.eventType === 'VAULT_DEPOSIT';

      try {
         await prisma.$transaction(async tx => {
            await tx.vaultEventLog.create({
               data: {
                  eventType: event.eventType,
                  wallet,
                  creatorId,
                  quantity,
                  ledger: Number(event.ledger),
                  txHash: String(event.txHash),
                  eventIndex: Number(event.eventIndex),
               },
            });

            const existing = await tx.vaultPosition.findUnique({
               where: { wallet_creatorId: { wallet, creatorId } },
               select: { quantity: true },
            });
            const current = Number(existing?.quantity ?? 0);
            const next = isDeposit ? current + qty : Math.max(0, current - qty);

            await tx.vaultPosition.upsert({
               where: { wallet_creatorId: { wallet, creatorId } },
               create: { wallet, creatorId, quantity: next },
               update: { quantity: next },
            });
         });
      } catch (error) {
         if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
         ) {
            logger.debug(
               { eventId: `${event.txHash}:${event.eventIndex}` },
               'Vault event already applied; skipping replay'
            );
            return;
         }
         throw error;
      }
   });
}
