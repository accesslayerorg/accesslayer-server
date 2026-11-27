
// SPDX-License-Identifier: MIT

import sanitizeHtml from "sanitize-html";

/**
 * Shared HTML sanitization utilities.
 *
 * These helpers provide centralized sanitization for user-generated content.
 * They are intended for content rendered in HTML contexts, including
 * comments, announcements, biographies, changelog entries, and support messages.
 *
 * IMPORTANT:
 * - sanitizeMarkdown sanitizes already-rendered HTML; it does not parse Markdown.
 * - sanitizeText strips HTML markup and returns text-oriented content.
 * - Sanitization is not a replacement for context-aware output encoding.
 * - Never inject unsanitized user input into JavaScript, CSS, or attributes.
 */

/**
 * Allowed HTML tags for formatted user-generated content.
 *
 * Keep this allowlist intentionally restrictive. Expand only when a legitimate
 * application requirement exists and the new element is safe.
 */
const ALLOWED_MARKDOWN_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "code",
  "pre",
  "hr",
  "a",
] as const;

/**
 * Allowed HTML attributes by tag.
 *
 * No event handlers, inline styles, or arbitrary attributes are allowed.
 */
const ALLOWED_MARKDOWN_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "title"],
};

/**
 * Allowed URL protocols.
 *
 * javascript:, data:, vbscript:, and other potentially dangerous schemes
 * are intentionally excluded.
 */
const ALLOWED_URL_SCHEMES = ["http", "https", "mailto"];

/**
 * Shared HTML sanitization configuration for formatted content.
 */
const MARKDOWN_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_MARKDOWN_TAGS],
  allowedAttributes: ALLOWED_MARKDOWN_ATTRIBUTES,
  allowedSchemes: ALLOWED_URL_SCHEMES,
  allowedSchemesByTag: {
    a: ["http", "https", "mailto"],
  },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  enforceHtmlBoundary: true,

  /**
   * Force safe relationship attributes on links.
   *
   * Existing user-provided rel attributes are not trusted.
   * We replace them with a controlled value.
   */
  transformTags: {
    a: (_tagName, attribs) => ({
      tagName: "a",
      attribs: {
        ...attribs,
        rel: "noopener noreferrer nofollow",
      },
    }),
  },
};

/**
 * Sanitizes formatted HTML content originating from Markdown or rich-text sources.
 *
 * This function expects HTML that has already been produced by a Markdown
 * renderer. It does not convert Markdown syntax into HTML.
 *
 * Allowed formatting includes basic text formatting, headings, lists,
 * blockquotes, code blocks, horizontal rules, and safe links.
 *
 * Dangerous tags, inline event handlers, unsafe URL schemes, and unsupported
 * attributes are removed.
 *
 * @param input - Rendered HTML content to sanitize.
 * @returns Sanitized HTML safe for insertion into an HTML content context.
 */
export function sanitizeMarkdown(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    return "";
  }

  return sanitizeHtml(input, MARKDOWN_SANITIZE_OPTIONS);
}

/**
 * Sanitizes plain-text user content by removing HTML markup.
 *
 * Intended for user content that should not support rich formatting,
 * such as bios, support messages, and plain-text comments.
 *
 * HTML tags and attributes are removed while the underlying text content
 * is retained.
 *
 * @param input - User-provided plain text.
 * @returns Sanitized text with HTML markup removed.
 */
export function sanitizeText(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    return "";
  }

  return sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
    allowedSchemes: [],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
  });
}
