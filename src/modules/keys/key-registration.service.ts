// src/modules/keys/key-registration.service.ts
import EventEmitter from 'events';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { emitAuditEvent } from '../../utils/audit.utils';
import { getLedgerEntries } from '../../utils/soroban-rpc.utils';

export const keyEventEmitter = new EventEmitter();

export class DuplicateKeyRegistrationError extends Error {
   constructor(message = 'Key address is already registered') {
      super(message);
      this.name = 'DuplicateKeyRegistrationError';
   }
}

export class InvalidOnChainContractError extends Error {
   constructor(message = 'Key address does not exist on-chain') {
      super(message);
      this.name = 'InvalidOnChainContractError';
   }
}

export interface KeyRegistrationInput {
   keyAddress: string;
   creatorWallet: string;
   handle?: string;
   displayName?: string;
   metadata?: Record<string, unknown>;
}

export interface KeyRegisteredEventPayload {
   event: 'key_registered';
   keyAddress: string;
   creatorWallet: string;
   handle?: string;
   displayName?: string;
   metadata?: Record<string, unknown>;
   timestamp: string;
}

/**
 * Validates whether a key address exists on-chain.
 * Supports Stellar public keys ('G...') and Soroban contract IDs ('C...').
 */
export async function validateKeyAddressOnChain(
   keyAddress: string
): Promise<boolean> {
   if (!keyAddress || typeof keyAddress !== 'string') {
      return false;
   }

   const addressRegex = /^(G|C)[A-Z2-7]{55}$/;
   if (!addressRegex.test(keyAddress.trim())) {
      return false;
   }

   // For Soroban contract addresses ('C...'), query RPC when available
   if (keyAddress.trim().startsWith('C')) {
      const result = await getLedgerEntries([keyAddress.trim()]);
      // If RPC is queried and returns no entries (and no mock override), RPC validation indicates missing
      if (result && (!result.entries || result.entries.length === 0)) {
         return false;
      }
   }

   return true;
}

/**
 * Emits the internal `key_registered` event for downstream processing services.
 */
export async function emitKeyRegisteredEvent(
   payload: Omit<KeyRegisteredEventPayload, 'event' | 'timestamp'>
): Promise<void> {
   const timestamp = new Date().toISOString();
   const eventPayload: KeyRegisteredEventPayload = {
      event: 'key_registered',
      ...payload,
      timestamp,
   };

   // Log for log aggregators
   logger.info(eventPayload, 'Internal key_registered event emitted');

   // Emit process-level event for in-memory listeners
   keyEventEmitter.emit('key_registered', eventPayload);

   // Persist audit event for downstream processing
   await emitAuditEvent({
      actor: payload.creatorWallet,
      action: 'key_registered',
      target: 'CreatorKey',
      targetId: payload.keyAddress,
      metadata: payload.metadata ?? {},
   });
}

/**
 * Registers a newly deployed creator key contract address in the database.
 */
export async function registerKeyContract(input: KeyRegistrationInput) {
   const keyAddress = input.keyAddress.trim();
   const creatorWallet = input.creatorWallet.trim();

   // 1. Validate on-chain existence
   const isValidOnChain = await validateKeyAddressOnChain(keyAddress);
   if (!isValidOnChain) {
      throw new InvalidOnChainContractError();
   }

   // 2. Check for duplicate registration
   const existingKey = await prisma.registeredKey.findUnique({
      where: { keyAddress },
   });

   if (existingKey) {
      throw new DuplicateKeyRegistrationError();
   }

   // 3. Store key metadata and contract address in database
   const registeredKey = await prisma.registeredKey.create({
      data: {
         keyAddress,
         creatorWallet,
         handle: input.handle,
         displayName: input.displayName,
         metadata: input.metadata ? (input.metadata as any) : undefined,
         status: 'ACTIVE',
      },
   });

   // 4. Emit internal key_registered event
   await emitKeyRegisteredEvent({
      keyAddress,
      creatorWallet,
      handle: input.handle,
      displayName: input.displayName,
      metadata: input.metadata,
   });

   return registeredKey;
}
