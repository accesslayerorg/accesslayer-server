import { truncateWallet } from './wallet-display.utils';

describe('truncateWallet', () => {
   it('truncates a 56-char Stellar address to 4...4 format', () => {
      const address =
         'GABC111111111111111111111111111111111111111111111111WXYZ';
      expect(truncateWallet(address)).toBe('GABC…WXYZ');
   });

   it('returns string shorter than 8 chars unchanged', () => {
      expect(truncateWallet('GABC')).toBe('GABC');
      expect(truncateWallet('GABCDEF')).toBe('GABCDEF');
   });

   it('returns empty string when given an empty string', () => {
      expect(truncateWallet('')).toBe('');
   });
});
