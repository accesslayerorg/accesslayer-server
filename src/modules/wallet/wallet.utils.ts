import { z } from 'zod';
import { prisma } from '../../utils/prisma.utils';
import { MapUserToWalletType } from './wallet.schemas';
import { logger } from '../../utils/logger.utils';

/**
 * Validates a Stellar Ed25519 public key address.
 * A valid address starts with 'G', is exactly 56 characters, and uses
 * the Base32 character set (A-Z, 2-7).
 */
export function isValidStellarAddress(address: string): boolean {
    return typeof address === 'string' && /^G[A-Z2-7]{55}$/.test(address);
}

/**
 * Zod schema that validates a Stellar wallet address using isValidStellarAddress.
 */
export const StellarAddressSchema = z
    .string()
    .refine(isValidStellarAddress, { message: 'Invalid Stellar wallet address' });

/**
 * Service boundary for Stellar wallet identity mapping.
 * Handles the association between application users and their Stellar public addresses.
 */

/**
 * Associates a Stellar address with a user.
 * If the user already has a wallet, it updates the address.
 * Ensures the address is unique across the system.
 */
export const upsertStellarWallet = async (
   input: MapUserToWalletType,
   requestId?: string
) => {
   try {
      return await prisma.stellarWallet.upsert({
         where: {
            userId: input.userId,
         },
         update: {
            address: input.address,
         },
         create: {
            userId: input.userId,
            address: input.address,
         },
      });
   } catch (error: any) {
      // Log duplicate wallet address errors with structured context
      if (error.code === 'P2002' && error.meta?.target?.includes('address')) {
         // Mask the address for logging (show first 8 and last 4 characters)
         const maskedAddress = maskWalletAddress(input.address);

         logger.warn(
            {
               type: 'wallet_address_duplicate',
               userId: input.userId,
               maskedAddress,
               ...(requestId ? { requestId } : {}),
            },
            'Duplicate wallet address detected during upsert'
         );
      }
      throw error;
   }
};

/**
 * Masks a wallet address for logging purposes.
 * Shows first 8 and last 4 characters with asterisks in between.
 */
function maskWalletAddress(address: string): string {
   if (!address || address.length < 12) {
      return '***';
   }
   return `${address.slice(0, 8)}...${address.slice(-4)}`;
}

/**
 * Retrieves the Stellar wallet associated with a user ID.
 */
export const getStellarWalletByUserId = async (userId: string) => {
   return await prisma.stellarWallet.findUnique({
      where: {
         userId,
      },
   });
};

/**
 * Retrieves the user associated with a Stellar address.
 */
export const getUserByStellarAddress = async (address: string) => {
   return await prisma.stellarWallet.findUnique({
      where: {
         address,
      },
      include: {
         user: true,
      },
   });
};

/**
 * Checks if a Stellar address is already registered in the system.
 */
export const isStellarAddressRegistered = async (address: string) => {
   const wallet = await prisma.stellarWallet.findUnique({
      where: {
         address,
      },
   });
   return !!wallet;
};
