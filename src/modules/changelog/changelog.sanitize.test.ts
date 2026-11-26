// src/modules/changelog/changelog.sanitize.test.ts

import {
   isSafeLinkDestination,
   sanitizeChangelogMarkdown,
   sanitizeChangelogTitle,
} from './changelog.sanitize';

describe('sanitizeChangelogMarkdown', () => {
   it('keeps ordinary markdown text verbatim', () => {
      const markdown = [
         '> Quoted note & context',
         '',
         '**Bold**, _italic_ and `code`, where 5 > 3 and a < b.',
         '',
         '- one',
         '- two',
         '',
         '[docs](https://docs.example.com/x) [relative](/help) [mail](mailto:team@example.com) [anchor](#top)',
      ].join('\n');
      expect(sanitizeChangelogMarkdown(markdown)).toBe(markdown);
   });

   it.each([
      ['<script>alert(1)</script>Release notes', 'Release notes'],
      ['<SCRIPT SRC=//evil.example/x.js></SCRIPT>ok', 'ok'],
      ['<img src=x onerror=alert(1)>ok', 'ok'],
      ['<svg onload=alert(1)><script>alert(1)</script></svg>ok', 'ok'],
      ['<iframe src="//evil.example"></iframe>ok', 'ok'],
      ['<style>body{display:none}</style>ok', 'ok'],
      ['<a href="javascript:alert(1)">click</a>', 'click'],
      ['<div style="background:url(javascript:alert(1))">ok</div>', 'ok'],
      ['<!-- hidden --><b onmouseover=alert(1)>ok</b>', 'ok'],
   ])('strips HTML payload %j', (input, expected) => {
      expect(sanitizeChangelogMarkdown(input)).toBe(expected);
   });

   it('does not let split tags reassemble into a script tag', () => {
      const out = sanitizeChangelogMarkdown('<<b>script>alert(1)<</b>/script>');
      expect(out).not.toMatch(/<\s*script/i);
      expect(out).not.toMatch(/<\/\s*script/i);
   });

   it('does not decode author-typed entities into real markup', () => {
      const input = '&lt;script&gt;alert(1)&lt;/script&gt;';
      expect(sanitizeChangelogMarkdown(input)).toBe(input);
   });

   it.each([
      '[x](javascript:alert(1))',
      '[x](JavaScript:alert(1))',
      '[x](java&#x53;cript:alert(1))',
      '[x](java&#115;cript:alert(1))',
      '[x](javascript&colon;alert(1))',
      '[x](javascript\\:alert(1))',
      '[x]( jav\tascript:alert(1))',
      '[x](<javascript:alert(1)>)',
      '![img](data:text/html;base64,PHNjcmlwdD4=)',
      '[x](vbscript:msgbox(1))',
   ])('neutralizes unsafe inline link %j', input => {
      const out = sanitizeChangelogMarkdown(input);
      const destinations = [...out.matchAll(/\]\(([^)]*)\)/g)].map(m => m[1]);
      expect(destinations.every(dest => isSafeLinkDestination(dest))).toBe(true);
      expect(out.toLowerCase()).not.toContain('script:');
      expect(out.toLowerCase()).not.toContain('data:');
   });

   it('keeps a safe link with a title and balanced parentheses', () => {
      const input =
         '[docs](https://docs.example.com "Docs") [wiki](https://en.wikipedia.org/wiki/A_(b))';
      expect(sanitizeChangelogMarkdown(input)).toBe(input);
   });

   // Parser-differential payloads from published sanitize-html advisories.
   // Each relies on a tag surviving; nothing may survive here.
   it.each([
      ['GHSA-x3q4-9hxx-gx8m', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>ok'],
      ['GHSA-g8qq-57p8-ggw5', '<svg><animate attributeName="href" values="javascript:alert(1)"/><a><text>x</text></a></svg>ok'],
      ['GHSA-cv27-6wvh-8x7j', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">ok'],
      ['GHSA-jxwj-j7wr-gfrw', '<textarea></textarea/><script>alert(1)</script>ok'],
   ])('neutralizes the %s payload', (_id, payload) => {
      const out = sanitizeChangelogMarkdown(payload);
      expect(out).not.toMatch(/<\s*[a-z!/?]/i);
      expect(out.toLowerCase()).not.toContain('javascript:');
   });

   it('neutralizes unsafe reference-style link definitions', () => {
      const out = sanitizeChangelogMarkdown('See [the docs][d].\n\n[d]: javascript:alert(1)');
      expect(out).toBe('See [the docs][d].\n\n[d]: #');
   });

   it('keeps safe reference-style link definitions', () => {
      const input = 'See [the docs][d].\n\n[d]: https://docs.example.com "Docs"';
      expect(sanitizeChangelogMarkdown(input)).toBe(input);
   });
});

describe('isSafeLinkDestination', () => {
   it.each(['https://a.example', 'http://a.example', 'mailto:a@b.c', '/path', 'path', '#frag', '?q=1'])(
      'allows %j',
      dest => expect(isSafeLinkDestination(dest)).toBe(true)
   );

   it.each(['javascript:x', 'data:text/html,x', 'file:///etc/passwd', 'vbscript:x'])(
      'rejects %j',
      dest => expect(isSafeLinkDestination(dest)).toBe(false)
   );
});

describe('sanitizeChangelogTitle', () => {
   it('strips markup and collapses whitespace', () => {
      expect(sanitizeChangelogTitle('  <b>Faster</b>\n  swaps <script>x</script> ')).toBe(
         'Faster swaps'
      );
   });
});
