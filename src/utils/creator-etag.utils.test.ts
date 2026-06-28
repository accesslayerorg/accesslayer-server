import { Response } from 'express';
import {
   attachCreatorETagHeader,
   computeCreatorETag,
   CREATOR_ETAG_HEADER,
} from './creator-etag.utils';

const mockRes = () =>
   ({ set: jest.fn() }) as unknown as Response;

describe('computeCreatorETag()', () => {
   it('returns a double-quoted 64-char hex string', () => {
      const etag = computeCreatorETag({ id: '1' });
      expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
   });

   it('produces the same ETag for identical data', () => {
      const a = computeCreatorETag({ id: '1', name: 'Alice' });
      const b = computeCreatorETag({ id: '1', name: 'Alice' });
      expect(a).toBe(b);
   });

   it('produces different ETags for different data', () => {
      const a = computeCreatorETag({ id: '1' });
      const b = computeCreatorETag({ id: '2' });
      expect(a).not.toBe(b);
   });

   it('handles null, arrays, and primitive values without throwing', () => {
      expect(() => computeCreatorETag(null)).not.toThrow();
      expect(() => computeCreatorETag(42)).not.toThrow();
      expect(() => computeCreatorETag('text')).not.toThrow();
      expect(() => computeCreatorETag([1, 2, 3])).not.toThrow();
   });
});

describe('attachCreatorETagHeader()', () => {
   it('sets the ETag header from raw data', () => {
      const res = mockRes();
      attachCreatorETagHeader(res, { id: '1' });
      expect(res.set).toHaveBeenCalledWith(
         CREATOR_ETAG_HEADER,
         expect.stringMatching(/^"[0-9a-f]{64}"$/),
      );
   });

   it('passes a pre-computed quoted ETag through unchanged', () => {
      const res = mockRes();
      const precomputed = '"abc123def456"';
      attachCreatorETagHeader(res, precomputed);
      expect(res.set).toHaveBeenCalledWith(CREATOR_ETAG_HEADER, precomputed);
   });

   it('hashes an unquoted string as data rather than using it verbatim', () => {
      const res = mockRes();
      attachCreatorETagHeader(res, 'not-an-etag');
      const [, value] = (res.set as jest.Mock).mock.calls[0];
      expect(value).toMatch(/^"[0-9a-f]{64}"$/);
      expect(value).not.toBe('"not-an-etag"');
   });

   it('does not touch other headers', () => {
      const res = mockRes();
      attachCreatorETagHeader(res, {});
      expect(res.set).toHaveBeenCalledTimes(1);
   });
});
