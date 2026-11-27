import {
   AttachmentPolicyError,
   assertAttachmentDeclarations,
   fileExtension,
   sniffAttachmentContent,
   verifyUploadedBytes,
} from './attachment-policy.utils';
import { MAX_ATTACHMENT_BYTES } from './support.constants';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-png')]);
const PDF = Buffer.from('%PDF-1.7\n%....');
const TEXT = Buffer.from('Plain notes about my payment.\nThanks!\n');
const DECLARED = (fileName: string, contentType: string, sizeBytes = 100) => ({
   fileName,
   contentType,
   sizeBytes,
});

describe('fileExtension', () => {
   it('returns the lower-cased extension or an empty string', () => {
      expect(fileExtension('Screenshot.PNG')).toBe('png');
      expect(fileExtension('archive.tar.gz')).toBe('gz');
      expect(fileExtension('README')).toBe('');
      expect(fileExtension('.hidden')).toBe('');
   });
});

describe('assertAttachmentDeclarations', () => {
   it('accepts up to three supported attachments within the size limit', () => {
      expect(() =>
         assertAttachmentDeclarations([
            DECLARED('shot.png', 'image/png', 1024),
            DECLARED('receipt.pdf', 'application/pdf', 2048),
            DECLARED('log.txt', 'text/plain', MAX_ATTACHMENT_BYTES),
         ])
      ).not.toThrow();
   });

   it('rejects a fourth attachment', () => {
      const four = Array.from({ length: 4 }, (_, index) => DECLARED(`f${index}.png`, 'image/png'));
      expect(() => assertAttachmentDeclarations(four)).toThrow(AttachmentPolicyError);
   });

   it('rejects a file over 5 MB', () => {
      expect(() =>
         assertAttachmentDeclarations([DECLARED('big.png', 'image/png', MAX_ATTACHMENT_BYTES + 1)])
      ).toThrow(/5 MB or smaller/);
   });

   it('blocks executable and script extensions even with a permitted content type', () => {
      expect(() => assertAttachmentDeclarations([DECLARED('setup.exe', 'image/png')])).toThrow(
         /Executable and script files are not allowed/
      );
      expect(() => assertAttachmentDeclarations([DECLARED('run.sh', 'text/plain')])).toThrow(
         AttachmentPolicyError
      );
   });

   it('rejects a content type that does not fit the extension', () => {
      expect(() => assertAttachmentDeclarations([DECLARED('photo.png', 'application/pdf')])).toThrow(
         /not supported/
      );
   });

   it('rejects names containing path separators', () => {
      expect(() => assertAttachmentDeclarations([DECLARED('../etc/x.png', 'image/png')])).toThrow(
         /File name is not valid/
      );
   });
});

describe('sniffAttachmentContent', () => {
   it('identifies supported types from their magic bytes', () => {
      expect(sniffAttachmentContent(PNG)).toEqual({ kind: 'allowed', contentType: 'image/png' });
      expect(sniffAttachmentContent(PDF)).toEqual({ kind: 'allowed', contentType: 'application/pdf' });
      expect(sniffAttachmentContent(TEXT)).toEqual({ kind: 'allowed', contentType: 'text/plain' });
   });

   it('blocks Windows, Linux and macOS executables and scripts', () => {
      expect(sniffAttachmentContent(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toMatchObject({ kind: 'blocked' });
      expect(sniffAttachmentContent(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]))).toMatchObject({ kind: 'blocked' });
      expect(sniffAttachmentContent(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07]))).toMatchObject({ kind: 'blocked' });
      expect(sniffAttachmentContent(Buffer.from('#!/bin/sh\necho hi\n'))).toMatchObject({ kind: 'blocked' });
      expect(sniffAttachmentContent(Buffer.from('<?php echo 1;'))).toMatchObject({ kind: 'blocked' });
   });

   it('treats binary data with no known signature as unknown', () => {
      expect(sniffAttachmentContent(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toEqual({ kind: 'unknown' });
   });
});

describe('verifyUploadedBytes', () => {
   it('accepts bytes that match the declared size and type', () => {
      expect(() => verifyUploadedBytes(PNG, 'image/png', PNG.length)).not.toThrow();
   });

   it('rejects a size that differs from the declared size', () => {
      expect(() => verifyUploadedBytes(PNG, 'image/png', PNG.length + 1)).toThrow(
         /does not match the declared size/
      );
   });

   it('rejects an executable renamed to look like an image', () => {
      const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
      try {
         verifyUploadedBytes(exe, 'image/png', exe.length);
         throw new Error('expected rejection');
      } catch (error) {
         expect(error).toBeInstanceOf(AttachmentPolicyError);
         expect((error as AttachmentPolicyError).statusCode).toBe(422);
         expect((error as Error).message).toMatch(/Windows executables/);
      }
   });

   it('rejects content whose type does not match the declaration', () => {
      expect(() => verifyUploadedBytes(TEXT, 'image/png', TEXT.length)).toThrow(/does not match its declared type/);
   });
});
