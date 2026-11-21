// src/modules/investor/whitelist.service.ts
import { prisma } from '../../utils/prisma.utils';

export class WhitelistNotFoundError extends Error {}

export async function addToWhitelist(creatorId: string, address: string) {
  return prisma.whitelist.upsert({
    where: { address_creatorId: { address, creatorId } },
    update: {},
    create: { address, creatorId },
  });
}

export async function removeFromWhitelist(creatorId: string, address: string) {
  const existing = await prisma.whitelist.findUnique({
    where: { address_creatorId: { address, creatorId } },
  });
  if (!existing) {
    throw new WhitelistNotFoundError();
  }
  await prisma.whitelist.delete({
    where: { address_creatorId: { address, creatorId } },
  });
}

export async function getWhitelistAddresses(creatorId: string) {
  const entries = await prisma.whitelist.findMany({
    where: { creatorId },
    select: { address: true },
    orderBy: { createdAt: 'asc' },
  });
  return entries.map((e: { address: string }) => e.address);
}
