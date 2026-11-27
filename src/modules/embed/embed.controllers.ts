import { NextFunction, Request, Response } from 'express';
import {
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import {
   EmbedBadgeQuerySchema,
   EmbedWidgetQuerySchema,
   UpdateEmbedSettingsBodySchema,
} from './embed.schemas';
import {
   buildFrameAncestorsCsp,
   EMBED_CACHE_MAX_AGE_SECONDS,
   embedService,
   renderBadgeSvg,
   renderNeutralPlaceholderSvg,
   renderWidgetHtml,
} from './embed.service';

export async function httpGetEmbedBadgeSvg(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsed = EmbedBadgeQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid badge query parameters',
            parsed.error.issues.map((issue) => ({
               field: issue.path.join('.') || 'query',
               message: issue.message,
            }))
         );
         return;
      }

      const { metric, style, theme } = parsed.data;
      const handle = String(req.params.handle ?? '');
      const data = await embedService.getKeyEmbedData(handle, metric);

      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader(
         'Cache-Control',
         `public, max-age=${EMBED_CACHE_MAX_AGE_SECONDS}`
      );

      if (!data.found || !data.enabled || !data.creatorId) {
         res.status(200).send(renderNeutralPlaceholderSvg({ style, theme }));
         return;
      }

      await embedService.incrementWeeklyLoadCount(data.creatorId);

      const svg = renderBadgeSvg({
         label: data.metricLabel,
         value: data.metricValue,
         style,
         theme,
      });
      res.status(200).send(svg);
   } catch (error) {
      next(error);
   }
}

export async function httpGetEmbedWidget(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsed = EmbedWidgetQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid widget query parameters',
            parsed.error.issues.map((issue) => ({
               field: issue.path.join('.') || 'query',
               message: issue.message,
            }))
         );
         return;
      }

      const { metric, theme } = parsed.data;
      const handle = String(req.params.handle ?? '');
      const data = await embedService.getKeyEmbedData(handle, metric);

      const csp =
         data.found && data.enabled
            ? buildFrameAncestorsCsp(data.allowedDomains)
            : "frame-ancestors 'none'";

      res.removeHeader('X-Frame-Options');
      res.setHeader('Content-Security-Policy', csp);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
         'Cache-Control',
         `public, max-age=${EMBED_CACHE_MAX_AGE_SECONDS}`
      );

      if (!data.found || !data.enabled || !data.creatorId) {
         res.status(200).send(
            renderWidgetHtml({
               handle: handle || 'unknown',
               displayName: 'AccessLayer',
               metricLabel: 'Status',
               metricValue: 'Embed Unavailable',
               theme,
            })
         );
         return;
      }

      await embedService.incrementWeeklyLoadCount(data.creatorId);

      res.status(200).send(
         renderWidgetHtml({
            handle: data.handle ?? handle,
            displayName: data.displayName ?? handle,
            metricLabel: data.metricLabel,
            metricValue: data.metricValue,
            theme,
         })
      );
   } catch (error) {
      next(error);
   }
}

export async function httpGetCreatorEmbedSettings(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const creatorId = String(req.params.id ?? '');
      const settings = await embedService.getSettings(creatorId);
      sendSuccess(res, settings);
   } catch (error) {
      next(error);
   }
}

export async function httpUpdateCreatorEmbedSettings(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsed = UpdateEmbedSettingsBodySchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid embed settings payload',
            parsed.error.issues.map((issue) => ({
               field: issue.path.join('.') || 'body',
               message: issue.message,
            }))
         );
         return;
      }

      const creatorId = String(req.params.id ?? '');
      const updated = await embedService.updateSettings(
         creatorId,
         parsed.data
      );
      sendSuccess(res, updated);
   } catch (error) {
      next(error);
   }
}
