// src/modules/factory/factory.service.ts
//
// Key factory registry API (#983): lookups over FactoryDeployedKey, plus a
// fallback to the general key registry (RegisteredKey) when an address is a
// real key but wasn't deployed through the factory.

import { prisma } from '../../utils/prisma.utils';

export interface FactoryKeySummary {
   contractAddress: string;
   creatorWallet: string;
   keyId: string | null;
   deployedAt: string;
   is_factory_key: true;
}

export interface NonFactoryKeySummary {
   contractAddress: string;
   creatorWallet: string;
   is_factory_key: false;
}

export class KeyAddressNotFoundError extends Error {
   constructor(address: string) {
      super(`No key found for address: ${address}`);
      this.name = 'KeyAddressNotFoundError';
   }
}

/**
 * All keys deployed by a given creator wallet, ordered by deployment order
 * (deployedAt ascending).
 */
export async function getFactoryKeysByCreator(
   creatorWallet: string
): Promise<FactoryKeySummary[]> {
   const rows = await prisma.factoryDeployedKey.findMany({
      where: { creatorWallet },
      orderBy: { deployedAt: 'asc' },
   });

   return rows.map(row => ({
      contractAddress: row.contractAddress,
      creatorWallet: row.creatorWallet,
      keyId: row.keyId,
      deployedAt: row.deployedAt.toISOString(),
      is_factory_key: true as const,
   }));
}

/**
 * Looks up a key by contract address. If it's in the factory registry,
 * returns its factory summary with is_factory_key: true. Otherwise falls
 * back to the general registered-key lookup and returns is_factory_key:
 * false. Throws KeyAddressNotFoundError only when the address isn't a key
 * anywhere.
 */
export async function getKeyByFactoryAddress(
   contractAddress: string
): Promise<FactoryKeySummary | NonFactoryKeySummary> {
   const factoryKey = await prisma.factoryDeployedKey.findUnique({
      where: { contractAddress },
   });

   if (factoryKey) {
      return {
         contractAddress: factoryKey.contractAddress,
         creatorWallet: factoryKey.creatorWallet,
         keyId: factoryKey.keyId,
         deployedAt: factoryKey.deployedAt.toISOString(),
         is_factory_key: true,
      };
   }

   const registeredKey = await prisma.registeredKey.findUnique({
      where: { keyAddress: contractAddress },
   });

   if (registeredKey) {
      return {
         contractAddress: registeredKey.keyAddress,
         creatorWallet: registeredKey.creatorWallet,
         is_factory_key: false,
      };
   }

   throw new KeyAddressNotFoundError(contractAddress);
}

/**
 * Checks whether a contract address exists in the factory registry.
 * Used to thread `is_factory_key` through existing key summary responses.
 */
export async function isFactoryKey(contractAddress: string): Promise<boolean> {
   const factoryKey = await prisma.factoryDeployedKey.findUnique({
      where: { contractAddress },
      select: { id: true },
   });
   return factoryKey !== null;
}
