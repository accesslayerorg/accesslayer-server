jest.mock('../../config', () => ({
   envConfig: {
      APP_SECRET: 'test_secret_for_hmac_123456789012',
   },
}));

import {
   encodeCursor,
   decodeCursor,
   generateCursorChecksum,
   CursorChecksumError,
} from '../cursor.utils';

describe('Cursor Utils', () => {
   const samplePayload = { id: 'user_123', createdAt: '2023-01-01T00:00:00.000Z' };

   describe('generateCursorChecksum', () => {
      it('should return a deterministic 64-character hex string for the same input', () => {
         const checksum1 = generateCursorChecksum('test_payload');
         const checksum2 = generateCursorChecksum('test_payload');
         
         expect(checksum1).toBe(checksum2);
         expect(checksum1).toHaveLength(64);
         expect(/^[0-9a-f]{64}$/.test(checksum1)).toBe(true);
      });
      
      it('should return different checksums for different inputs', () => {
         const checksum1 = generateCursorChecksum('test_payload_1');
         const checksum2 = generateCursorChecksum('test_payload_2');
         
         expect(checksum1).not.toBe(checksum2);
      });
   });

   describe('encodeCursor', () => {
      it('should generate a cursor containing exactly one dot delimiter', () => {
         const cursor = encodeCursor(samplePayload);
         expect(cursor).toContain('.');
         expect(cursor.split('.')).toHaveLength(2);
      });

      it('should generate consistent cursors for the same payload object', () => {
         const cursor1 = encodeCursor(samplePayload);
         const cursor2 = encodeCursor(samplePayload);
         expect(cursor1).toBe(cursor2);
      });
   });

   describe('decodeCursor', () => {
      it('should correctly decode a valid cursor', () => {
         const cursor = encodeCursor(samplePayload);
         const decoded = decodeCursor<typeof samplePayload>(cursor);
         expect(decoded).toEqual(samplePayload);
      });

      it('should throw CursorChecksumError for invalid formats', () => {
         expect(() => decodeCursor('not_a_valid_cursor')).toThrow(CursorChecksumError);
         expect(() => decodeCursor('foo.bar.baz')).toThrow(CursorChecksumError);
      });

      it('should throw CursorChecksumError when checksum is tampered', () => {
         const cursor = encodeCursor(samplePayload);
         const [payload, checksum] = cursor.split('.');
         const tamperedChecksum = checksum.substring(0, 63) + (checksum.endsWith('a') ? 'b' : 'a');
         const tamperedCursor = `${payload}.${tamperedChecksum}`;
         
         expect(() => decodeCursor(tamperedCursor)).toThrow(CursorChecksumError);
      });

      it('should throw CursorChecksumError when payload is tampered', () => {
         const cursor = encodeCursor(samplePayload);
         const [payload, checksum] = cursor.split('.');
         // Change base64 by modifying a character
         const tamperedPayload = payload.substring(0, payload.length - 1) + (payload.endsWith('a') ? 'b' : 'a');
         const tamperedCursor = `${tamperedPayload}.${checksum}`;
         
         expect(() => decodeCursor(tamperedCursor)).toThrow(CursorChecksumError);
      });

      it('should throw CursorChecksumError for empty string inputs', () => {
         expect(() => decodeCursor('')).toThrow(CursorChecksumError);
         expect(() => decodeCursor('.')).toThrow(CursorChecksumError);
         expect(() => decodeCursor('payload.')).toThrow(CursorChecksumError);
         expect(() => decodeCursor('.checksum')).toThrow(CursorChecksumError);
      });
      
      it('should throw CursorChecksumError for invalid target typed primitives', () => {
           
          expect(() => decodeCursor(123 as any)).toThrow(CursorChecksumError);
      });
      
      it('should throw CursorChecksumError for malformed JSON payload', () => {
          const badJsonStr = 'bad_json_string';
          const payload = Buffer.from(badJsonStr).toString('base64url');
          const checksum = generateCursorChecksum(payload);
          const cursor = `${payload}.${checksum}`;
          
          expect(() => decodeCursor(cursor)).toThrow(CursorChecksumError);
      });
   });
});
