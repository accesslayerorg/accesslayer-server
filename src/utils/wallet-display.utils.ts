/**
 * Truncate a Stellar wallet address to the standard display format (first 4 and last 4 characters).
 *
 * @param address - The full wallet address
 * @returns Truncated address in format: GABC…WXYZ
 */
export function truncateWallet(address: string): string {
   if (!address) {
      return '';
   }
   if (address.length < 8) {
      return address;
   }
   return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
