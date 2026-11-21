import { AsyncController } from '../../types/auth.types';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import {
   getCreatorShareData,
   generateOgHtml,
   generateOgImageSvg,
   SHARE_CACHE_PREFIX,
   SHARE_CACHE_TTL_SECONDS,
} from './share.service';

export const httpGetCreatorShare: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      let handle = req.params.handle;
      if (Array.isArray(handle)) {
         handle = handle[0];
      }
      const stringHandle: string = handle;
      const cacheKey = `${SHARE_CACHE_PREFIX}${stringHandle}`;
      const data = await getCreatorShareData(stringHandle);

      let cached = await cacheGetJson<string>(cacheKey);
      if (cached) {
         return res.send(cached);
      }

      if (!data) {
         const fallbackHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
   <meta charset="UTF-8">
   <meta property="og:title" content="Creator not found">
   <meta property="og:description" content="The requested creator could not be found">
   <meta property="og:type" content="website">
   <meta property="og:image" content="/placeholder-image.png">
   <meta property="og:url" content="https://accesslayer.com/creators/${handle}">
   <meta property="og:site_name" content="Access Layer">
   <meta name="twitter:card" content="summary">
   <meta name="twitter:title" content="Creator not found">
   <meta name="twitter:description" content="The requested creator could not be found">
   <meta http-equiv="refresh" content="0; url=https://accesslayer.com">
</head>
<body>
   <p>Creator not found</p>
</body>
</html>
      `;
         await cacheSetJson(cacheKey, fallbackHtml, SHARE_CACHE_TTL_SECONDS);
         return res.send(fallbackHtml);
      }

      const html = generateOgHtml(data);
      await cacheSetJson(cacheKey, html, SHARE_CACHE_TTL_SECONDS);
      return res.send(html);
   } catch (error) {
      next(error);
   }
};

export const httpGetCreatorShareImage: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      let handle = req.params.handle;
      if (Array.isArray(handle)) {
         handle = handle[0];
      }
      const stringHandle: string = handle;
      const data = await getCreatorShareData(stringHandle);

      if (!data) {
         return res.status(404).type('png').send(`
<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
   <rect width="1200" height="630" fill="#1a1a2e"/>
   <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="40" fill="#888" >Creator not found</text>
</svg>
      `);
      }

      const svg = generateOgImageSvg(data);
      return res.type('svg+xml').send(svg);
   } catch (error) {
      next(error);
   }
};