// src/modules/support/support.constants.ts
// Shared limits and vocabulary for support tickets (#1327).

export const SUPPORT_CATEGORIES = [
   'account',
   'payments',
   'keys',
   'trading',
   'creators',
   'technical',
   'other',
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const TICKET_STATUSES = ['open', 'waiting', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * Allowed status changes. `waiting` means the team is waiting on the user.
 * A user reply moves `waiting` or `resolved` back to `open`. `closed` is final.
 */
export const TICKET_STATUS_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
   open: ['waiting', 'resolved', 'closed'],
   waiting: ['open', 'resolved', 'closed'],
   resolved: ['open', 'closed'],
   closed: [],
};

export const MAX_ATTACHMENTS_PER_TICKET = 3;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_NAME_MAX_LENGTH = 120;

/** How long an attachment upload link stays valid after the ticket is created. */
export const ATTACHMENT_UPLOAD_TTL_MS = 15 * 60 * 1000;
export const ATTACHMENT_UPLOAD_PURPOSE = 'support-attachment-upload';

/** Content types accepted for attachments, with the extensions each may use. */
export const ALLOWED_ATTACHMENT_TYPES: Readonly<Record<string, readonly string[]>> = {
   'image/png': ['png'],
   'image/jpeg': ['jpg', 'jpeg'],
   'image/gif': ['gif'],
   'image/webp': ['webp'],
   'application/pdf': ['pdf'],
   'text/plain': ['txt', 'log'],
};

/**
 * Extensions refused outright, before any content check. Executables, scripts,
 * installers and archives that can carry them.
 */
export const BLOCKED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
   'exe', 'dll', 'so', 'dylib', 'bin', 'run', 'elf', 'out', 'com', 'scr', 'msi',
   'msp', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'wsh', 'hta', 'lnk',
   'js', 'jse', 'mjs', 'sh', 'bash', 'zsh', 'command', 'app', 'pkg', 'dmg',
   'deb', 'rpm', 'apk', 'jar', 'class', 'wasm', 'php', 'py', 'rb', 'pl', 'cgi',
]);
