jest.mock('./cursor.utils', () => ({
    decodeCursor: jest.fn(),
    CursorChecksumError: class CursorChecksumError extends Error {
        constructor(msg = 'Invalid cursor') {
            super(msg);
            this.name = 'CursorChecksumError';
        }
    },
}));

import { formatCursorForDebug } from './cursor-debug.utils';
import { decodeCursor, CursorChecksumError } from './cursor.utils';

const decodeMock = decodeCursor as jest.MockedFunction<typeof decodeCursor>;

beforeEach(() => {
    decodeMock.mockReset();
});

describe('formatCursorForDebug()', () => {
    it('returns a string-keyed map for a valid cursor', () => {
        decodeMock.mockReturnValue({ createdAt: '2024-01-01T00:00:00.000Z', id: 'abc123' });

        const result = formatCursorForDebug('valid-cursor');

        expect(result).toEqual({ createdAt: '2024-01-01T00:00:00.000Z', id: 'abc123' });
    });

    it('converts non-string values to strings', () => {
        decodeMock.mockReturnValue({ page: 3, active: true } as any);

        const result = formatCursorForDebug('valid-cursor');

        expect(result).toEqual({ page: '3', active: 'true' });
    });

    it('returns null for a tampered cursor (CursorChecksumError)', () => {
        decodeMock.mockImplementation(() => {
            throw new CursorChecksumError('Cursor checksum mismatch');
        });

        const result = formatCursorForDebug('tampered-cursor');

        expect(result).toBeNull();
    });

    it('returns null for an empty string', () => {
        expect(formatCursorForDebug('')).toBeNull();
    });

    it('returns null for a non-string input', () => {
        expect(formatCursorForDebug(null)).toBeNull();
        expect(formatCursorForDebug(undefined)).toBeNull();
        expect(formatCursorForDebug(42)).toBeNull();
    });

    it('returns null when decoded payload is not a plain object', () => {
        decodeMock.mockReturnValue(['not', 'an', 'object'] as any);

        expect(formatCursorForDebug('array-cursor')).toBeNull();
    });

    it('coerces null payload values to empty string', () => {
        decodeMock.mockReturnValue({ id: 'abc', extra: null } as any);

        const result = formatCursorForDebug('cursor');

        expect(result).toEqual({ id: 'abc', extra: '' });
    });
});
