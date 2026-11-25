import crypto from 'crypto';
import { envConfig } from '../../config';
import { prisma } from '../../utils/prisma.utils';
import { PublishDisclosureInput } from './disclosures.schemas';

export class NoActiveDisclosureError extends Error {
   constructor() {
      super('No active risk disclosure version is published');
      this.name = 'NoActiveDisclosureError';
   }
}

export class OutdatedDisclosureVersionError extends Error {
   constructor(provided: string, current: string) {
      super(
         `Disclosure version ${provided} is outdated; current version is ${current}`
      );
      this.name = 'OutdatedDisclosureVersionError';
   }
}

export class DisclosureVersionExistsError extends Error {
   constructor(version: string) {
      super(`Disclosure version ${version} already exists`);
      this.name = 'DisclosureVersionExistsError';
   }
}

/**
 * Computes a rotating daily salt derived from `APP_SECRET` and the UTC date
 * so raw IP addresses and user agents are never stored.
 */
export function getRotatingSalt(now: Date = new Date()): string {
   const dayBucket = now.toISOString().slice(0, 10);
   return crypto
      .createHmac('sha256', envConfig.APP_SECRET)
      .update(`disclosure-salt:${dayBucket}`)
      .digest('hex');
}

export function hashWithRotatingSalt(
   value: string,
   now: Date = new Date(),
   saltOverride?: string
): string {
   const salt = saltOverride ?? getRotatingSalt(now);
   return crypto
      .createHmac('sha256', salt)
      .update(value || 'unknown')
      .digest('hex');
}

export async function getCurrentDisclosure() {
   const active = await prisma.disclosureVersion.findFirst({
      where: { isActive: true },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
   });

   if (!active) {
      throw new NoActiveDisclosureError();
   }

   return {
      id: active.id,
      version: active.version,
      textHash: active.textHash,
      contentUrl: active.contentUrl,
      publishedAt: active.publishedAt,
   };
}

export async function acceptDisclosure(
   wallet: string,
   versionId: string,
   ip: string,
   userAgent: string,
   now: Date = new Date()
) {
   const active = await prisma.disclosureVersion.findFirst({
      where: { isActive: true },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
   });

   if (!active) {
      throw new NoActiveDisclosureError();
   }

   if (versionId !== active.id && versionId !== active.version) {
      throw new OutdatedDisclosureVersionError(versionId, active.id);
   }

   const ipHash = hashWithRotatingSalt(ip, now);
   const userAgentHash = hashWithRotatingSalt(userAgent, now);

   return prisma.disclosureAcceptance.upsert({
      where: {
         wallet_versionId: {
            wallet,
            versionId: active.id,
         },
      },
      create: {
         wallet,
         versionId: active.id,
         version: active.version,
         acceptedAt: now,
         ipHash,
         userAgentHash,
      },
      update: {
         acceptedAt: now,
         ipHash,
         userAgentHash,
      },
   });
}

export async function publishDisclosureVersion(
   input: PublishDisclosureInput,
   publishedBy?: string
) {
   const existing = await prisma.disclosureVersion.findUnique({
      where: { version: input.version },
      select: { id: true },
   });
   if (existing) {
      throw new DisclosureVersionExistsError(input.version);
   }

   return prisma.$transaction(async tx => {
      await tx.disclosureVersion.updateMany({
         where: { isActive: true },
         data: { isActive: false },
      });

      return tx.disclosureVersion.create({
         data: {
            version: input.version,
            textHash: input.textHash,
            contentUrl: input.contentUrl,
            isActive: true,
            publishedBy,
         },
      });
   });
}

export async function checkDisclosureStatus(wallet: string | undefined) {
   const active = await prisma.disclosureVersion.findFirst({
      where: { isActive: true },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
   });

   if (!active) {
      return { required: false, accepted: true, currentVersion: null };
   }

   if (!wallet) {
      return { required: true, accepted: false, currentVersion: active };
   }

   const acceptance = await prisma.disclosureAcceptance.findUnique({
      where: {
         wallet_versionId: {
            wallet,
            versionId: active.id,
         },
      },
      select: { id: true, acceptedAt: true },
   });

   return {
      required: true,
      accepted: Boolean(acceptance),
      currentVersion: active,
   };
}
