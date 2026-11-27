// src/modules/support/attachment-policy.utils.ts
// Attachment checks for support tickets (#1327). Declared metadata is checked
// when the ticket is created. The bytes are checked when they are uploaded,
// by their magic numbers, so a renamed executable is still refused.

import {
   ALLOWED_ATTACHMENT_TYPES,
   ATTACHMENT_NAME_MAX_LENGTH,
   BLOCKED_ATTACHMENT_EXTENSIONS,
   MAX_ATTACHMENTS_PER_TICKET,
   MAX_ATTACHMENT_BYTES,
} from './support.constants';

export class AttachmentPolicyError extends Error {
   constructor(
      message: string,
      public readonly field: string | undefined,
      public readonly statusCode: 400 | 422 = 400
   ) {
      super(message);
      this.name = 'AttachmentPolicyError';
   }
}

export interface AttachmentDeclaration {
   fileName: string;
   /** Lower-cased content type. */
   contentType: string;
   sizeBytes: number;
}

export type SniffResult =
   | { kind: 'allowed'; contentType: string }
   | { kind: 'blocked'; reason: string }
   | { kind: 'unknown' };

/** Lower-case extension without the dot, or '' when there is none. */
export function fileExtension(fileName: string): string {
   const dot = fileName.lastIndexOf('.');
   if (dot <= 0 || dot === fileName.length - 1) return '';
   return fileName.slice(dot + 1).toLowerCase();
}

function isSafeFileName(fileName: string): boolean {
   return (
      fileName.length > 0 &&
      fileName.length <= ATTACHMENT_NAME_MAX_LENGTH &&
      !/[\\/\0]/.test(fileName) &&
      fileName !== '.' &&
      fileName !== '..'
   );
}

/**
 * Checks declared attachments before any upload link is issued.
 *
 * @throws {AttachmentPolicyError} for too many files, a blocked or unsupported
 *         type, an unsafe name, or a file over the size limit.
 */
export function assertAttachmentDeclarations(attachments: AttachmentDeclaration[]): void {
   if (attachments.length > MAX_ATTACHMENTS_PER_TICKET) {
      throw new AttachmentPolicyError(
         `A ticket can have at most ${MAX_ATTACHMENTS_PER_TICKET} attachments`,
         'attachments'
      );
   }

   attachments.forEach((attachment, index) => {
      const field = `attachments.${index}`;
      if (!isSafeFileName(attachment.fileName)) {
         throw new AttachmentPolicyError('File name is not valid', `${field}.fileName`);
      }

      const extension = fileExtension(attachment.fileName);
      if (BLOCKED_ATTACHMENT_EXTENSIONS.has(extension)) {
         throw new AttachmentPolicyError(
            `Executable and script files are not allowed (.${extension})`,
            `${field}.fileName`
         );
      }

      const allowedExtensions = ALLOWED_ATTACHMENT_TYPES[attachment.contentType];
      if (!allowedExtensions || !allowedExtensions.includes(extension)) {
         throw new AttachmentPolicyError(
            'File type is not supported. Use PNG, JPEG, GIF, WebP, PDF or plain text.',
            `${field}.contentType`
         );
      }

      if (attachment.sizeBytes > MAX_ATTACHMENT_BYTES) {
         throw new AttachmentPolicyError(
            'Each attachment must be 5 MB or smaller',
            `${field}.sizeBytes`
         );
      }
   });
}

const startsWithBytes = (bytes: Buffer, prefix: readonly number[], offset = 0): boolean =>
   prefix.every((value, index) => bytes[offset + index] === value);

const asciiAt = (bytes: Buffer, start: number, length: number): string =>
   bytes.subarray(start, start + length).toString('latin1');

// Mach-O (both endians, 32 and 64 bit) and Java class / fat binary magic.
const MACH_O_MAGICS: readonly (readonly number[])[] = [
   [0xfe, 0xed, 0xfa, 0xce],
   [0xfe, 0xed, 0xfa, 0xcf],
   [0xce, 0xfa, 0xed, 0xfe],
   [0xcf, 0xfa, 0xed, 0xfe],
   [0xca, 0xfe, 0xba, 0xbe],
];

const SNIFF_SAMPLE_BYTES = 4096;

/** True when the leading bytes look like text: no NULs and no control bytes. */
function looksLikeText(bytes: Buffer): boolean {
   const end = Math.min(bytes.length, SNIFF_SAMPLE_BYTES);
   for (let index = 0; index < end; index++) {
      const value = bytes[index];
      if (value === 0) return false;
      if (value < 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0d) return false;
   }
   return true;
}

/**
 * Identifies uploaded bytes from their magic numbers. Executables and scripts
 * are reported as `blocked` before any allowed type is considered.
 */
export function sniffAttachmentContent(bytes: Buffer): SniffResult {
   if (bytes.length === 0) return { kind: 'unknown' };

   if (startsWithBytes(bytes, [0x4d, 0x5a])) {
      return { kind: 'blocked', reason: 'Windows executables are not allowed' };
   }
   if (startsWithBytes(bytes, [0x7f, 0x45, 0x4c, 0x46])) {
      return { kind: 'blocked', reason: 'Linux executables are not allowed' };
   }
   if (MACH_O_MAGICS.some(magic => startsWithBytes(bytes, magic))) {
      return { kind: 'blocked', reason: 'macOS executables are not allowed' };
   }
   if (startsWithBytes(bytes, [0x23, 0x21])) {
      return { kind: 'blocked', reason: 'Scripts are not allowed' };
   }
   if (asciiAt(bytes, 0, 5).toLowerCase() === '<?php') {
      return { kind: 'blocked', reason: 'Scripts are not allowed' };
   }

   if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      return { kind: 'allowed', contentType: 'image/png' };
   }
   if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) {
      return { kind: 'allowed', contentType: 'image/jpeg' };
   }
   const gifHeader = asciiAt(bytes, 0, 6);
   if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
      return { kind: 'allowed', contentType: 'image/gif' };
   }
   if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') {
      return { kind: 'allowed', contentType: 'image/webp' };
   }
   if (asciiAt(bytes, 0, 5) === '%PDF-') {
      return { kind: 'allowed', contentType: 'application/pdf' };
   }
   if (looksLikeText(bytes)) {
      return { kind: 'allowed', contentType: 'text/plain' };
   }
   return { kind: 'unknown' };
}

/**
 * Validates uploaded bytes against the declared size and content type.
 *
 * @throws {AttachmentPolicyError} 400 when the size differs from the declared
 *         size; 422 when the content is blocked, unknown or of another type.
 */
export function verifyUploadedBytes(
   bytes: Buffer,
   declaredContentType: string,
   declaredSizeBytes: number
): void {
   if (bytes.length !== declaredSizeBytes) {
      throw new AttachmentPolicyError(
         'Uploaded size does not match the declared size',
         undefined,
         400
      );
   }

   const sniffed = sniffAttachmentContent(bytes);
   if (sniffed.kind === 'blocked') {
      throw new AttachmentPolicyError(sniffed.reason, undefined, 422);
   }
   if (sniffed.kind === 'unknown' || sniffed.contentType !== declaredContentType) {
      throw new AttachmentPolicyError(
         'File content does not match its declared type',
         undefined,
         422
      );
   }
}
