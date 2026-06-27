// Unit tests for buildValidationError helper (#490)
//
// Covers: correct shape returned for multiple field/message/code combinations.

import { buildValidationError } from './validation-error.utils';

describe('buildValidationError', () => {
    it('returns correct shape with all three fields', () => {
        const result = buildValidationError('wallet_address', 'Invalid Stellar address', 'INVALID_ADDRESS');

        expect(result).toEqual({
            error: {
                code: 'INVALID_ADDRESS',
                field: 'wallet_address',
                message: 'Invalid Stellar address',
            },
        });
    });

    it('returns correct shape for a required field error', () => {
        const result = buildValidationError('creator_id', 'creator_id is required', 'REQUIRED');

        expect(result.error.field).toBe('creator_id');
        expect(result.error.message).toBe('creator_id is required');
        expect(result.error.code).toBe('REQUIRED');
    });

    it('returns correct shape for a range violation', () => {
        const result = buildValidationError('target_price', 'target_price must be positive', 'OUT_OF_RANGE');

        expect(result.error.field).toBe('target_price');
        expect(result.error.message).toBe('target_price must be positive');
        expect(result.error.code).toBe('OUT_OF_RANGE');
    });

    it('error object contains exactly the three expected keys', () => {
        const result = buildValidationError('email', 'Invalid email format', 'INVALID_FORMAT');

        expect(Object.keys(result.error)).toEqual(['code', 'field', 'message']);
    });

    it('preserves arbitrary field names and messages without mutation', () => {
        const field = 'callback_url';
        const message = 'callback_url must be a valid URL';
        const code = 'INVALID_URL';

        const result = buildValidationError(field, message, code);

        expect(result.error.field).toBe(field);
        expect(result.error.message).toBe(message);
        expect(result.error.code).toBe(code);
    });
});
