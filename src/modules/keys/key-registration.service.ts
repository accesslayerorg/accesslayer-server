import { prisma } from '../../utils/prisma.utils';
import { verifyKeyAddressOnChain } from './key-validation.service';
import { emitKeyRegisteredEvent } from './key-events.service';
import { logger } from '../../utils/logger.utils';

export class InvalidOnChainKeyError extends Error {
   constructor(message = 'Key address does not exist on-chain') {
      super(message);
      this.name = 'InvalidOnChainKeyError';
   }
}

export class DuplicateKeyAddressError extends Error {
   constructor(message = 'Key contract address is already registered') {
      super(message);
      this.name = 'DuplicateKeyAddressError';
   }
}

export interface RegisterKeyInput {
   keyAddress: string;
   creatorWallet: string;
   metadata?: Record<string, unknown>;
}

/**
 * Registers a newly deployed creator key contract address into the database.
 * Validates on-chain existence, checks for duplicates, persists metadata, and emits event.
 */
export async function registerKeyContract(input: RegisterKeyInput) {
   const { keyAddress, creatorWallet, metadata = {} } = input;
   const registeredKeyClient = (prisma as any).registeredKey;

   // 1. On-chain validation
   const isValidOnChain = await verifyKeyAddressOnChain(keyAddress);
   if (!isValidOnChain) {
      logger.warn(
         { keyAddress },
         'Rejecting key registration: address not found on-chain'
      );
      throw new InvalidOnChainKeyError(
         `Key address ${keyAddress} does not exist on-chain`
      );
   }

   // 2. Duplicate registration check
   const existing = await registeredKeyClient.findUnique({
      where: { keyAddress },
   });

   if (existing) {
      logger.warn({ keyAddress }, 'Rejecting duplicate key registration');
      throw new DuplicateKeyAddressError(
         `Key contract address ${keyAddress} is already registered`
      );
   }

   // 3. Persist registration in database
   const registeredKey = await registeredKeyClient.create({
      data: {
         keyAddress,
         creatorWallet,
         metadata: metadata as any,
         status: 'ACTIVE',
      },
   });

   // 4. Emit internal key_registered event for downstream processing
   emitKeyRegisteredEvent({
      keyAddress: registeredKey.keyAddress,
      creatorWallet: registeredKey.creatorWallet,
      metadata: (registeredKey.metadata as Record<string, unknown>) || {},
      registeredAt: registeredKey.createdAt,
   });

   return registeredKey;
}
