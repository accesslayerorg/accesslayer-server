import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * On-chain key state read from Soroban contract.
 */
export interface OnChainKeyState {
   circulatingSupply: Decimal;
   currentPrice: Decimal;
   holderCount: number;
   tradingPaused: boolean;
}

/**
 * Database key state from server.
 */
export interface DatabaseKeyState {
   circulatingSupply: Decimal;
   currentPrice: Decimal;
   holderCount: number;
   tradingPaused: boolean;
}

/**
 * Change detected for a field during sync.
 */
export interface FieldChange {
   field: string;
   oldValue: unknown;
   newValue: unknown;
}

/**
 * Result of a key state sync operation.
 */
export interface KeySyncResult {
   creatorId: string;
   changedFields: FieldChange[];
   success: boolean;
   timestamp: Date;
}

/**
 * Reads the current on-chain state for a key from the Soroban contract.
 *
 * In a full implementation, this would:
 * 1. Get contract ID for the key
 * 2. Build XDR keys for persistent storage queries
 * 3. Call getLedgerEntries() via Soroban RPC
 * 4. Decode XDR responses to extract circulatingSupply, currentPrice, holderCount, tradingPaused
 *
 * For now, this is a placeholder that demonstrates the expected return type.
 */
async function readOnChainState(creatorId: string): Promise<OnChainKeyState | null> {
   try {
      // TODO: Implement Soroban RPC calls to read contract state
      // This would require:
      // 1. Contract ID lookup from creator or global config
      // 2. Build ledger entry keys for persistent storage
      // 3. Call getLedgerEntries() from soroban-rpc.utils
      // 4. Decode XDR responses
      // 5. Return structured state

      logger.debug(
         { creatorId },
         'Reading on-chain state (placeholder implementation)'
      );

      // Placeholder return - actual implementation would query contract
      return null;
   } catch (error) {
      logger.error(
         { error, creatorId },
         'Failed to read on-chain state'
      );
      return null;
   }
}

/**
 * Reads the current database state for a key.
 */
async function readDatabaseState(
   creatorId: string
): Promise<DatabaseKeyState | null> {
   try {
      const creator = await prisma.creatorProfile.findUnique({
         where: { id: creatorId },
         select: {
            circulatingSupply: true,
            id: true,
            tradingPaused: true,
         },
      });

      if (!creator) {
         return null;
      }

      // Get current price from price snapshot
      const priceSnapshot = await prisma.creatorPriceSnapshot.findUnique({
         where: { creatorId },
         select: { currentPrice: true },
      });

      // Count unique holders (non-zero balance)
      const holderCount = await prisma.keyOwnership.count({
         where: {
            creatorId,
            balance: { gt: 0 },
         },
      });

      return {
         circulatingSupply: creator.circulatingSupply,
         currentPrice: priceSnapshot ? new Decimal(priceSnapshot.currentPrice.toString()) : new Decimal(0),
         holderCount,
         tradingPaused: creator.tradingPaused,
      };
   } catch (error) {
      logger.error(
         { error, creatorId },
         'Failed to read database state'
      );
      return null;
   }
}

/**
 * Compares two states and returns the fields that changed.
 */
function detectChanges(
   onChain: OnChainKeyState,
   database: DatabaseKeyState
): FieldChange[] {
   const changes: FieldChange[] = [];

   // Check circulatingSupply
   const onChainSupply = onChain.circulatingSupply;
   const dbSupply = database.circulatingSupply;
   if (!onChainSupply.equals(dbSupply)) {
      changes.push({
         field: 'circulatingSupply',
         oldValue: dbSupply.toFixed(),
         newValue: onChainSupply.toFixed(),
      });
   }

   // Check currentPrice
   const onChainPrice = onChain.currentPrice;
   const dbPrice = database.currentPrice;
   if (!onChainPrice.equals(dbPrice)) {
      changes.push({
         field: 'currentPrice',
         oldValue: dbPrice.toFixed(),
         newValue: onChainPrice.toFixed(),
      });
   }

   // Check holderCount
   if (onChain.holderCount !== database.holderCount) {
      changes.push({
         field: 'holderCount',
         oldValue: database.holderCount,
         newValue: onChain.holderCount,
      });
   }

   // Check tradingPaused
   if (onChain.tradingPaused !== database.tradingPaused) {
      changes.push({
         field: 'tradingPaused',
         oldValue: database.tradingPaused,
         newValue: onChain.tradingPaused,
      });
   }

   return changes;
}

/**
 * Syncs a key's on-chain state with the database.
 * Reads current on-chain state and overwrites database fields within a transaction.
 * Returns a summary of changes made.
 *
 * @param creatorId - The key/creator ID to sync
 * @returns Sync result with changed fields and success status
 */
export async function syncKeyState(creatorId: string): Promise<KeySyncResult> {
   const result: KeySyncResult = {
      creatorId,
      changedFields: [],
      success: false,
      timestamp: new Date(),
   };

   try {
      // Verify creator exists
      const creator = await prisma.creatorProfile.findUnique({
         where: { id: creatorId },
         select: { id: true },
      });

      if (!creator) {
         logger.warn(
            { creatorId },
            'Attempted to sync non-existent creator'
         );
         throw new Error('Creator not found');
      }

      // Read on-chain state
      const onChainState = await readOnChainState(creatorId);
      if (!onChainState) {
         logger.warn(
            { creatorId },
            'Failed to read on-chain state during sync'
         );
         throw new Error('Failed to read on-chain state');
      }

      // Read current database state
      const databaseState = await readDatabaseState(creatorId);
      if (!databaseState) {
         logger.error(
            { creatorId },
            'Failed to read database state during sync'
         );
         throw new Error('Failed to read database state');
      }

      // Detect changes
      const changes = detectChanges(onChainState, databaseState);
      result.changedFields = changes;

      // If no changes, we're done
      if (changes.length === 0) {
         logger.info(
            { creatorId },
            'Key state already in sync, no changes needed'
         );
         result.success = true;
         return result;
      }

      // Update database within a transaction
      await prisma.$transaction(async (tx) => {
         // Build update data
         const updateData: Record<string, unknown> = {};

         for (const change of changes) {
            if (change.field === 'circulatingSupply') {
               updateData.circulatingSupply = onChainState.circulatingSupply;
            } else if (change.field === 'tradingPaused') {
               updateData.tradingPaused = onChainState.tradingPaused;
            }
         }

         // Update creator profile
         if (Object.keys(updateData).length > 0) {
            await tx.creatorProfile.update({
               where: { id: creatorId },
               data: updateData,
            });
         }

         // Update price snapshot if currentPrice changed
         const priceChange = changes.find((c) => c.field === 'currentPrice');
         if (priceChange) {
            await tx.creatorPriceSnapshot.upsert({
               where: { creatorId },
               update: { currentPrice: BigInt(onChainState.currentPrice.toString()) },
               create: {
                  creatorId,
                  currentPrice: BigInt(onChainState.currentPrice.toString()),
               },
            });
         }

         // Note: holderCount is derived from KeyOwnership, so it doesn't need
         // a direct update. It's recalculated during queries.
      });

      logger.info(
         {
            creatorId,
            changedFieldCount: changes.length,
            changes: changes.map((c) => ({
               field: c.field,
               oldValue: c.oldValue,
               newValue: c.newValue,
            })),
         },
         'Key state synchronized successfully'
      );

      result.success = true;
      return result;
   } catch (error) {
      logger.error(
         { error, creatorId },
         'Failed to sync key state'
      );
      throw error;
   }
}

/**
 * Verifies that a creator exists.
 */
export async function creatorExists(creatorId: string): Promise<boolean> {
   try {
      const creator = await prisma.creatorProfile.findUnique({
         where: { id: creatorId },
         select: { id: true },
      });
      return !!creator;
   } catch (error) {
      logger.error({ error, creatorId }, 'Error checking creator existence');
      return false;
   }
}
