import {
   buildFrameAncestorsCsp,
   EmbedService,
   escapeXml,
   getWeekStartUtc,
   renderBadgeSvg,
   renderNeutralPlaceholderSvg,
   renderWidgetHtml,
} from './embed.service';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findUnique: jest.fn() },
      keyOwnership: { count: jest.fn() },
      activity: { count: jest.fn() },
      embedSettings: { findUnique: jest.fn(), upsert: jest.fn() },
      embedWeeklyLoad: { upsert: jest.fn() },
   },
}));

describe('EmbedService', () => {
   const service = new EmbedService();

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('escapes XML/HTML special characters to prevent injection', () => {
      const escaped = escapeXml(`<script>alert("xss"&'1')</script>`);
      expect(escaped).toBe(
         '&lt;script&gt;alert(&quot;xss&quot;&amp;&#39;1&#39;)&lt;/script&gt;'
      );
      const svg = renderBadgeSvg({
         label: '<evil>',
         value: '"100"',
         style: 'flat',
         theme: 'dark',
      });
      expect(svg).not.toContain('<evil>');
      expect(svg).toContain('&lt;evil&gt;');
      expect(svg).toContain('&quot;100&quot;');

      const html = renderWidgetHtml({
         handle: '<img src=x>',
         displayName: 'Bob & Co',
         metricLabel: 'Price',
         metricValue: '1.0 XLM',
         theme: 'light',
      });
      expect(html).not.toContain('<img src=x>');
      expect(html).toContain('&lt;img src=x&gt;');
      expect(html).toContain('Bob &amp; Co');
   });

   it('builds Content-Security-Policy frame-ancestors from allowlist', () => {
      expect(buildFrameAncestorsCsp([])).toBe("frame-ancestors 'none'");
      expect(
         buildFrameAncestorsCsp(['https://example.com', 'https://app.site.io'])
      ).toBe("frame-ancestors 'self' https://example.com https://app.site.io");
   });

   it('renders valid neutral placeholder SVG', () => {
      const svg = renderNeutralPlaceholderSvg({ style: 'pill', theme: 'light' });
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain('Unavailable');
   });

   it('increments weekly load count per key', async () => {
      const upsert = (prisma as any).embedWeeklyLoad.upsert as jest.Mock;
      upsert.mockResolvedValue({ count: 1 });
      const now = new Date('2026-11-25T12:00:00Z'); // Wednesday
      const expectedWeekStart = getWeekStartUtc(now);

      await service.incrementWeeklyLoadCount('creator-1', now);

      expect(upsert).toHaveBeenCalledWith({
         where: {
            creatorId_weekStart: {
               creatorId: 'creator-1',
               weekStart: expectedWeekStart,
            },
         },
         create: {
            creatorId: 'creator-1',
            weekStart: expectedWeekStart,
            count: 1,
         },
         update: {
            count: { increment: 1 },
         },
      });
   });
});
