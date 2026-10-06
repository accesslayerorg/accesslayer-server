// src/modules/keys/key-transfer.service.ts
import { prisma } from '../../utils/prisma.utils';
import { KeyNotFoundError } from './key-fees.service';
import { PositionFrozenError } from './key-freeze.service';

export async function transferKeys(
  keyId: string,
  fromAddress: string,
  toAddress: string,
  quantity: number
) {
  if (quantity <= 0) {
    throw new Error('Quantity must be positive');
  }
  if (fromAddress === toAddress) {
    throw new Error('Cannot transfer to the same address');
  }

  const creator = await prisma.creatorProfile.findUnique({
    where: { id: keyId },
    select: { id: true },
  });
  if (!creator) {
    throw new KeyNotFoundError(keyId);
  }

  return prisma.$transaction(async (tx: any) => {
    const sender = await tx.keyOwnership.findUnique({
      where: { ownerAddress_creatorId: { ownerAddress: fromAddress, creatorId: keyId } },
      select: { balance: true, frozen: true },
    });
    // Self-custody freeze (#885): frozen positions cannot be transferred.
    if (sender?.frozen) {
      throw new PositionFrozenError(keyId);
    }
    const senderBalance = Number(sender?.balance ?? 0);
    if (senderBalance < quantity) {
      throw new Error('Insufficient balance');
    }

    const result = await tx.keyOwnership.upsert({
      where: { ownerAddress_creatorId: { ownerAddress: toAddress, creatorId: keyId } },
      update: { balance: { increment: quantity } },
      create: { ownerAddress: toAddress, creatorId: keyId, balance: quantity },
    });

    await tx.keyOwnership.update({
      where: { ownerAddress_creatorId: { ownerAddress: fromAddress, creatorId: keyId } },
      data: { balance: { decrement: quantity } },
    });

    return { from: fromAddress, to: toAddress, quantity, newBalance: Number(result.balance) };
  });
}
