import { z } from 'zod';
import {
   EMBED_METRICS,
   EMBED_STYLES,
   EMBED_THEMES,
} from './embed.service';

export const EmbedBadgeQuerySchema = z.object({
   metric: z.enum(EMBED_METRICS).default('price'),
   style: z.enum(EMBED_STYLES).default('flat'),
   theme: z.enum(EMBED_THEMES).default('dark'),
});

export const EmbedWidgetQuerySchema = z.object({
   metric: z.enum(EMBED_METRICS).default('price'),
   theme: z.enum(EMBED_THEMES).default('light'),
});

export const UpdateEmbedSettingsBodySchema = z.object({
   enabled: z.boolean(),
   allowedDomains: z
      .array(
         z
            .string()
            .trim()
            .min(1)
            .max(255)
            .regex(/^[a-zA-Z0-9.*:/-]+$/, 'Invalid domain or origin format')
      )
      .max(50),
});
