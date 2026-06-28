// Unit tests for isValidStellarAddress and StellarAddressSchema (#447)

import { isValidStellarAddress, StellarAddressSchema } from '../wallet.utils';

// 56-character valid Stellar G address (all uppercase base32 chars A-Z, 2-7)
const VALID_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('isValidStellarAddress', () => {
    it('returns true for a valid Stellar G... address', () => {
        expect(isValidStellarAddress(VALID_ADDRESS)).toBe(true);
    });

    it('returns true for an address using digits 2-7', () => {
        // Replace some chars with valid Base32 digits
        const addr = 'G' + '2'.repeat(55);
        expect(isValidStellarAddress(addr)).toBe(true);
    });

    it('returns false when the address does not start with G', () => {
        const addr = 'A' + 'A'.repeat(55);
        expect(isValidStellarAddress(addr)).toBe(false);
    });

    it('returns false when the address is too short (55 chars)', () => {
        const addr = 'G' + 'A'.repeat(54);
        expect(isValidStellarAddress(addr)).toBe(false);
    });

    it('returns false when the address is too long (57 chars)', () => {
        const addr = 'G' + 'A'.repeat(56);
        expect(isValidStellarAddress(addr)).toBe(false);
    });

    it('returns false when the address contains invalid characters (lowercase)', () => {
        const addr = 'G' + 'a'.repeat(55);
        expect(isValidStellarAddress(addr)).toBe(false);
    });

    it('returns false when the address contains invalid digits (0, 1, 8, 9)', () => {
        const addr = 'G' + '0'.repeat(55);
        expect(isValidStellarAddress(addr)).toBe(false);
    });

    it('returns false for an empty string', () => {
        expect(isValidStellarAddress('')).toBe(false);
    });

    it('returns false for a random non-address string', () => {
        expect(isValidStellarAddress('not-a-stellar-address')).toBe(false);
    });
});

describe('StellarAddressSchema', () => {
    it('passes for a valid Stellar address', () => {
        const result = StellarAddressSchema.safeParse(VALID_ADDRESS);
        expect(result.success).toBe(true);
    });

    it('fails with the correct message for a wrong first character', () => {
        const result = StellarAddressSchema.safeParse('A' + 'A'.repeat(55));
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0].message).toBe('Invalid Stellar wallet address');
        }
    });

    it('fails for wrong length', () => {
        const result = StellarAddressSchema.safeParse('G' + 'A'.repeat(54));
        expect(result.success).toBe(false);
    });

    it('fails for invalid characters', () => {
        const result = StellarAddressSchema.safeParse('G' + '!'.repeat(55));
        expect(result.success).toBe(false);
    });

    it('fails for an empty string', () => {
        const result = StellarAddressSchema.safeParse('');
        expect(result.success).toBe(false);
    });
});
