import { prisma } from '../../utils/prisma.utils';

export const SHARE_CACHE_PREFIX = 'share:v1:';
export const SHARE_CACHE_TTL_SECONDS = 600; // 10 minutes

function escapeHtml(text: string): string {
   return text
      .replace(/&/g, '&')
      .replace(/</g, '<')
      .replace(/>/g, '>')
      .replace(/"/g, '"')
      .replace(/'/g, '\x27');
}

interface CreatorShareData {
   handle: string;
   displayName: string | null;
   bio: string | null;
   avatarUrl: string | null;
   price: string;
   holderCount: number;
   priceBucket: string;
}

function getPriceBucket(price: string): string {
   const p = Number(price);
   if (isNaN(p)) return '0';
   return `${Math.floor(p / 10) * 10}`;
}

export async function getCreatorShareData(
   handle: string
): Promise<CreatorShareData | null> {
   const resolved = await prisma.creatorProfile.findFirst({
      where: {
         OR: [
            { handle },
            { id: handle },
         ],
      },
      select: {
         id: true,
         handle: true,
         displayName: true,
         bio: true,
         avatarUrl: true,
      },
   });

   if (!resolved) return null;

   const holderCount = await prisma.keyOwnership.count({
      where: { creatorId: resolved.id, balance: { gt: 0 } },
   });

   const priceSnapshot = await prisma.creatorPriceSnapshot.findFirst({
      where: { creatorId: resolved.id },
      orderBy: { updatedAt: 'desc' },
      select: { currentPrice: true },
   });

   const price = priceSnapshot?.currentPrice?.toString() || '0';

   return {
      handle: resolved.handle,
      displayName: resolved.displayName,
      bio: resolved.bio,
      avatarUrl: resolved.avatarUrl,
      price,
      holderCount,
      priceBucket: getPriceBucket(price),
   };
}

export function generateOgHtml(data: CreatorShareData): string {
   const escapedDisplayName = escapeHtml(data.displayName ?? data.handle);
   const escapedBio = escapeHtml(data.bio ?? '');
   const avatarUrl = data.avatarUrl ?? '/placeholder-image.png';

   return `<!DOCTYPE html>
<html lang="en">
<head>
   <meta charset="UTF-8">
   <meta property="og:title" content="${escapedDisplayName}">
   <meta property="og:description" content="${escapedBio}">
   <meta property="og:type" content="website">
   <meta property="og:image" content="${avatarUrl}">
   <meta property="og:url" content="https://accesslayer.com/creators/${data.handle}">
   <meta property="og:site_name" content="Access Layer">
   <meta name="twitter:card" content="summary_large_image">
   <meta name="twitter:title" content="${escapedDisplayName}">
   <meta name="twitter:description" content="${escapedBio}">
   <meta name="twitter:image" content="${avatarUrl}">
   <meta http-equiv="refresh" content="0; url=https://accesslayer.com/creators/${data.handle}">
</head>
<body>
   <p>Creator: ${escapedDisplayName}</p>
   <p>Price: ${data.price}</p>
   <p>Holders: ${data.holderCount}</p>
</body>
</html>`;
}

export function generateOgImageSvg(data: CreatorShareData): string {
   const escapedDisplayName = escapeHtml(data.displayName ?? data.handle);
   const price = data.price;
   const holderCount = data.holderCount;

   return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
   <defs>
      <linearGradient id="grad" x1="0%" y1="0%" x2="0%" y2="100%">
         <stop offset="0%" stop-color="#1a1a2e"/>
         <stop offset="100%" stop-color="#151525"/>
      </linearGradient>
   </defs>
   <rect width="1200" height="630" fill="url(#grad)"/>
   <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="60" fill="#ff6b6b">${escapedDisplayName}</text>
   <text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" font-size="40" fill="#ffd93d">${price}</text>
   <text x="50%" y="60%" dominant-baseline="middle" text-anchor="middle" font-size="36" fill="#4ecdc4">${holderCount} holders</text>
</svg>`;
}

export async function getCreatorShareImageSvg(
   handle: string
): Promise<CreatorShareData | null> {
   return await getCreatorShareData(handle);
}