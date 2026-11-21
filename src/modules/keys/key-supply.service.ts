// src/modules/keys/key-supply.service.ts
import { prisma } from '../../utils/prisma.utils';

export class KeyNotFoundError extends Error {
  constructor(keyId: string) {
    super(`Key not found: ${keyId}`);
    this.name = 'KeyNotFoundError';
  }
}

export interface KeySupply {
  supplyCap: number | null;
  circulatingSupply: number;
  burnedSupply: number;
  remainingMintable: number | null;
}

export async function getKeySupply(keyId: string): Promise<KeySupply> {
  const creator = await prisma.creatorProfile.findUnique({
    where: { id: keyId },
    select: {
      supplyCap: true,
      circulatingSupply: true,
      burnedSupply: true,
    },
  });

  if (!creator) {
    throw new KeyNotFoundError(keyId);
  }

  const circulating = Number(creator.circulatingSupply);
  const burned = creator.burnedSupply;
  const cap = creator.supplyCap;

  return {
    supplyCap: cap ?? null,
    circulatingSupply: circulating,
    burnedSupply: burned,
    remainingMintable: cap != null ? cap - circulating : null,
  };
}
