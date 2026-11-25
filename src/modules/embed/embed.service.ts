// src/modules/embed/embed.service.ts
// Embeddable SVG badge, HTML widget, origin allowlist CSP, and weekly load
// tracking (#1320).

import { prisma } from '../../utils/prisma.utils';

export const EMBED_METRICS = ['price', 'holders', 'supply', 'volume'] as const;
export type EmbedMetric = (typeof EMBED_METRICS)[number];

export const EMBED_STYLES = ['flat', 'rounded', 'pill'] as const;
export type EmbedStyle = (typeof EMBED_STYLES)[number];

export const EMBED_THEMES = ['light', 'dark'] as const;
export type EmbedTheme = (typeof EMBED_THEMES)[number];

export const EMBED_CACHE_MAX_AGE_SECONDS = 300; // 5 minutes
const STROOPS_PER_XLM = 10_000_000;

interface EmbedDb {
   creatorProfile: {
      findUnique: (args: any) => Promise<{
         id: string;
         handle: string;
         displayName: string;
         circulatingSupply: unknown;
         priceSnapshot?: { price: bigint | number } | null;
         embedSettings?: { enabled: boolean; allowedDomains: string[] } | null;
      } | null>;
   };
   keyOwnership: {
      count: (args: any) => Promise<number>;
   };
   activity: {
      count: (args: any) => Promise<number>;
   };
   embedSettings: {
      findUnique: (args: any) => Promise<{
         id: string;
         creatorId: string;
         enabled: boolean;
         allowedDomains: string[];
      } | null>;
      upsert: (args: any) => Promise<{
         id: string;
         creatorId: string;
         enabled: boolean;
         allowedDomains: string[];
      }>;
   };
   embedWeeklyLoad: {
      upsert: (args: any) => Promise<{ count: number }>;
   };
}

/**
 * Escapes all XML/HTML special characters to prevent SVG/HTML injection.
 */
export function escapeXml(value: string): string {
   return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
}

/**
 * Computes the UTC Monday 00:00:00.000 start of the week for `date`.
 */
export function getWeekStartUtc(date: Date = new Date()): Date {
   const day = date.getUTCDay(); // 0 = Sun, 1 = Mon, ...
   const diffToMonday = day === 0 ? -6 : 1 - day;
   return new Date(
      Date.UTC(
         date.getUTCFullYear(),
         date.getUTCMonth(),
         date.getUTCDate() + diffToMonday,
         0,
         0,
         0,
         0
      )
   );
}

/**
 * Sanitizes allowed domains and builds a Content-Security-Policy
 * `frame-ancestors` directive. Empty allowlist blocks all external origins.
 */
export function buildFrameAncestorsCsp(allowedDomains: string[]): string {
   const cleaned = allowedDomains
      .map((d) => d.trim())
      .filter((d) => /^[a-zA-Z0-9.*:/-]+$/.test(d));

   if (cleaned.length === 0) {
      return "frame-ancestors 'none'";
   }
   return `frame-ancestors 'self' ${cleaned.join(' ')}`;
}

function getBorderRadius(style: EmbedStyle): number {
   if (style === 'flat') return 0;
   if (style === 'pill') return 12;
   return 4;
}

export function renderBadgeSvg(params: {
   label: string;
   value: string;
   style: EmbedStyle;
   theme: EmbedTheme;
}): string {
   const safeLabel = escapeXml(params.label);
   const safeValue = escapeXml(params.value);
   const rx = getBorderRadius(params.style);

   const labelBg = params.theme === 'dark' ? '#1f2937' : '#374151';
   const valueBg = params.theme === 'dark' ? '#0f172a' : '#2563eb';
   const textColor = '#ffffff';

   const labelWidth = Math.max(64, safeLabel.length * 7 + 16);
   const valueWidth = Math.max(64, safeValue.length * 7 + 16);
   const totalWidth = labelWidth + valueWidth;
   const height = 24;

   return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" role="img" aria-label="${safeLabel}: ${safeValue}">`,
      `<clipPath id="r"><rect width="${totalWidth}" height="${height}" rx="${rx}" fill="#fff"/></clipPath>`,
      `<g clip-path="url(#r)">`,
      `<rect width="${labelWidth}" height="${height}" fill="${labelBg}"/>`,
      `<rect x="${labelWidth}" width="${valueWidth}" height="${height}" fill="${valueBg}"/>`,
      `</g>`,
      `<g fill="${textColor}" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
      `<text x="${Math.round(labelWidth / 2)}" y="16">${safeLabel}</text>`,
      `<text x="${labelWidth + Math.round(valueWidth / 2)}" y="16" font-weight="bold">${safeValue}</text>`,
      `</g>`,
      `</svg>`,
   ].join('');
}

export function renderNeutralPlaceholderSvg(params: {
   style: EmbedStyle;
   theme: EmbedTheme;
}): string {
   return renderBadgeSvg({
      label: 'AccessLayer',
      value: 'Unavailable',
      style: params.style,
      theme: params.theme,
   });
}

export function renderWidgetHtml(params: {
   handle: string;
   displayName: string;
   metricLabel: string;
   metricValue: string;
   theme: EmbedTheme;
}): string {
   const safeHandle = escapeXml(params.handle);
   const safeName = escapeXml(params.displayName);
   const safeLabel = escapeXml(params.metricLabel);
   const safeValue = escapeXml(params.metricValue);
   const bg = params.theme === 'dark' ? '#0f172a' : '#ffffff';
   const fg = params.theme === 'dark' ? '#f8fafc' : '#0f172a';
   const border = params.theme === 'dark' ? '#1e293b' : '#e2e8f0';

   return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${safeName} (@${safeHandle})</title>
<style>
  body { margin:0; font-family: system-ui, -apple-system, sans-serif; background:${bg}; color:${fg}; }
  .card { border:1px solid ${border}; border-radius:10px; padding:14px 16px; display:flex; justify-content:space-between; align-items:center; }
  .name { font-weight:600; font-size:14px; }
  .handle { font-size:12px; opacity:0.75; }
  .metric { text-align:right; }
  .label { font-size:11px; text-transform:uppercase; opacity:0.7; }
  .value { font-size:16px; font-weight:700; }
</style>
</head>
<body>
  <div class="card">
    <div>
      <div class="name">${safeName}</div>
      <div class="handle">@${safeHandle}</div>
    </div>
    <div class="metric">
      <div class="label">${safeLabel}</div>
      <div class="value">${safeValue}</div>
    </div>
  </div>
</body>
</html>`;
}

export class EmbedService {
   private get db(): EmbedDb {
      return prisma as unknown as EmbedDb;
   }

   async incrementWeeklyLoadCount(
      creatorId: string,
      now: Date = new Date()
   ): Promise<void> {
      const weekStart = getWeekStartUtc(now);
      await this.db.embedWeeklyLoad.upsert({
         where: {
            creatorId_weekStart: { creatorId, weekStart },
         },
         create: {
            creatorId,
            weekStart,
            count: 1,
         },
         update: {
            count: { increment: 1 },
         },
      });
   }

   async getKeyEmbedData(
      handle: string,
      metric: EmbedMetric
   ): Promise<{
      found: boolean;
      enabled: boolean;
      creatorId?: string;
      handle?: string;
      displayName?: string;
      allowedDomains: string[];
      metricLabel: string;
      metricValue: string;
   }> {
      const profile = await this.db.creatorProfile.findUnique({
         where: { handle },
         select: {
            id: true,
            handle: true,
            displayName: true,
            circulatingSupply: true,
            priceSnapshot: { select: { price: true } },
            embedSettings: { select: { enabled: true, allowedDomains: true } },
         },
      });

      if (!profile) {
         return {
            found: false,
            enabled: false,
            allowedDomains: [],
            metricLabel: 'AccessLayer',
            metricValue: 'Unavailable',
         };
      }

      const enabled = profile.embedSettings?.enabled ?? true;
      const allowedDomains = profile.embedSettings?.allowedDomains ?? [];
      if (!enabled) {
         return {
            found: true,
            enabled: false,
            creatorId: profile.id,
            handle: profile.handle,
            displayName: profile.displayName,
            allowedDomains,
            metricLabel: 'AccessLayer',
            metricValue: 'Unavailable',
         };
      }

      let metricLabel = 'Price';
      let metricValue = '0 XLM';

      if (metric === 'price') {
         const priceXlm = profile.priceSnapshot
            ? Number(profile.priceSnapshot.price) / STROOPS_PER_XLM
            : 0;
         metricLabel = `${profile.handle} price`;
         metricValue = `${priceXlm.toFixed(4)} XLM`;
      } else if (metric === 'holders') {
         const holdersCount = await this.db.keyOwnership.count({
            where: { creatorId: profile.id, balance: { gt: 0 } },
         });
         metricLabel = `${profile.handle} holders`;
         metricValue = String(holdersCount);
      } else if (metric === 'supply') {
         metricLabel = `${profile.handle} supply`;
         metricValue = String(Number(profile.circulatingSupply));
      } else if (metric === 'volume') {
         const tradeCount = await this.db.activity.count({
            where: {
               creatorId: profile.id,
               type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] },
            },
         });
         metricLabel = `${profile.handle} trades`;
         metricValue = String(tradeCount);
      }

      return {
         found: true,
         enabled: true,
         creatorId: profile.id,
         handle: profile.handle,
         displayName: profile.displayName,
         allowedDomains,
         metricLabel,
         metricValue,
      };
   }

   async getSettings(creatorId: string) {
      const existing = await this.db.embedSettings.findUnique({
         where: { creatorId },
      });
      return (
         existing ?? {
            creatorId,
            enabled: true,
            allowedDomains: [],
         }
      );
   }

   async updateSettings(
      creatorId: string,
      data: { enabled: boolean; allowedDomains: string[] }
   ) {
      return this.db.embedSettings.upsert({
         where: { creatorId },
         create: {
            creatorId,
            enabled: data.enabled,
            allowedDomains: data.allowedDomains,
         },
         update: {
            enabled: data.enabled,
            allowedDomains: data.allowedDomains,
         },
      });
   }
}

export const embedService = new EmbedService();
