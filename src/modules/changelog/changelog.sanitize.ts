// src/modules/changelog/changelog.sanitize.ts
// Save-time sanitization for changelog markdown (#1356).
//
// Entries are stored as markdown, not HTML. HTML is stripped with the shared
// `sanitizeText` helper, but that helper HTML-escapes the text it keeps
// (`> quote` becomes `&gt; quote`), which breaks markdown, and it does not
// look at markdown link syntax, so `[x](javascript:...)` passes through.
// This module restores the escapes `sanitizeText` added and neutralizes
// unsafe link destinations, leaving ordinary markdown untouched.

import { sanitizeText } from '../../lib/sanitize';

const SAFE_LINK_SCHEMES = new Set(['http', 'https', 'mailto']);

// Private-use placeholder for `&`, so entities the author typed (for example
// `&lt;script&gt;`) are never decoded into real markup by the parser, and every
// entity in the sanitizer's output is one it added itself.
const AMPERSAND = '';

/** Removes every HTML tag and comment while keeping surrounding text verbatim. */
function stripHtmlOnce(input: string): string {
   const hidden = input.replace(/&/g, AMPERSAND);
   return sanitizeText(hidden)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(new RegExp(AMPERSAND, 'g'), '&');
}

/**
 * Strips HTML until the text no longer changes. A single pass is not enough:
 * removing `<b>` from `<<b>script>` leaves `<script>` behind.
 */
function stripHtml(input: string): string {
   let current = input;
   for (;;) {
      const next = stripHtmlOnce(current);
      if (next === current) return next;
      current = next;
   }
}

const NAMED_ENTITIES: Record<string, string> = {
   colon: ':',
   tab: '\t',
   newline: '\n',
   amp: '&',
};

/** Decodes the entity and escape forms a markdown renderer would decode in a URL. */
function normalizeDestination(raw: string): string {
   return raw
      .replace(/&#x([0-9a-f]+);?/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);?/g, (_m, dec) => String.fromCodePoint(Number(dec)))
      .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
      .replace(/\\([!-/:-@[-`{-~])/g, '$1')
      .replace(/[\u0000- \u007f-\u009f]/g, '')
      .toLowerCase();
}

/** True when the destination is relative, a fragment, or uses an allowed scheme. */
export function isSafeLinkDestination(raw: string): boolean {
   const normalized = normalizeDestination(raw.replace(/^<|>$/g, ''));
   const scheme = /^([a-z][a-z0-9+.-]*):/.exec(normalized);
   return !scheme || SAFE_LINK_SCHEMES.has(scheme[1]);
}

// Inline links and images: `[text](dest "title")` / `![alt](dest)`. The
// destination runs to the closing parenthesis (allowing one level of balanced
// parentheses, as CommonMark does) so whitespace tricks such as
// `jav<TAB>ascript:` are judged as a whole, the way browsers strip them.
const INLINE_LINK = /(\]\(\s*)(<[^>\n]*>|(?:[^()\n]|\([^()\n]*\))*)/g;
// Reference definitions: `[id]: dest "title"`.
const REFERENCE_DEFINITION = /^(\s{0,3}\[[^\]\n]+\]:\s*)(<[^>\n]*>|\S+)/gm;

function neutralizeUnsafeLinks(markdown: string): string {
   const replace = (_m: string, prefix: string, dest: string) =>
      prefix + (isSafeLinkDestination(dest) ? dest : '#');
   return markdown.replace(INLINE_LINK, replace).replace(REFERENCE_DEFINITION, replace);
}

/** Sanitizes a markdown body for storage. */
export function sanitizeChangelogMarkdown(input: string): string {
   return neutralizeUnsafeLinks(stripHtml(input)).trim();
}

/** Sanitizes a single-line title: no markup, collapsed whitespace. */
export function sanitizeChangelogTitle(input: string): string {
   return stripHtml(input).replace(/\s+/g, ' ').trim();
}
