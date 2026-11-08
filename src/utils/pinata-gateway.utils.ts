import { envConfig } from '../config';

/**
 * Canonical IPFS URI scheme and gateway path segment.
 */
const IPFS_URI_SCHEME = 'ipfs://';
const IPFS_GATEWAY_PATH = '/ipfs/';

/**
 * Extracts a bare IPFS CID from the many forms the social metadata extension
 * contract (and operators) may emit.
 *
 * Accepted inputs:
 * - Bare CID: `bafy...` / `Qm...`
 * - IPFS URI: `ipfs://bafy...`
 * - Gateway URL: `https://gateway.pinata.cloud/ipfs/bafy.../image.png`
 * - Path fragment: `/ipfs/bafy...`
 *
 * Everything after the CID (file name, query string, fragment) is discarded.
 *
 * @param input - Raw CID, URI, or gateway URL (may be null/undefined)
 * @returns The bare CID, or null when no CID can be extracted
 */
export function normalizeIpfsCid(input?: string | null): string | null {
   if (!input) {
      return null;
   }

   let value = input.trim();
   if (!value) {
      return null;
   }

   if (value.startsWith(IPFS_URI_SCHEME)) {
      value = value.slice(IPFS_URI_SCHEME.length);
   }

   const pathIndex = value.indexOf(IPFS_GATEWAY_PATH);
   if (pathIndex !== -1) {
      value = value.slice(pathIndex + IPFS_GATEWAY_PATH.length);
   }

   const cid = value.split(/[/?#]/)[0]?.trim() ?? '';
   return cid.length > 0 ? cid : null;
}

/**
 * Validates that a string is a well-formed IPFS CID.
 *
 * Recognized encodings:
 * - CIDv0: base58btc multihash, always 46 chars starting with `Qm`
 * - CIDv1: multibase prefix (`b` base32, `z` base58btc, `f`/`F` hex, `u` base64url)
 *
 * @param cid - Bare CID to validate
 * @returns True when the input looks like a valid CID
 */
export function isValidIpfsCid(cid?: string | null): boolean {
   if (!cid) {
      return false;
   }

   const value = cid.trim();
   if (!value) {
      return false;
   }

   // CIDv0: base58btc sha2-256 multihash (Qm + 44 base58 chars).
   if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(value)) {
      return true;
   }

   // CIDv1: multibase-prefixed, minimum payload length for a sha2-256 hash.
   return /^(b[a-z2-7]{20,}|B[a-zA-Z2-7]{20,}|z[1-9A-HJ-NP-Za-km-z]{20,}|f[0-9a-f]{20,}|F[0-9A-F]{20,}|u[0-9A-Za-z_-]{20,})$/.test(
      value
   );
}

/**
 * Resolves an avatar CID to a fully-qualified Pinata gateway URL.
 *
 * The gateway base is configured via `PINATA_GATEWAY_URL` (default:
 * `https://gateway.pinata.cloud/ipfs`). Trailing slashes on the base are
 * normalized away so the result is always `<base>/<cid>`.
 *
 * @param cid - Raw CID, IPFS URI, or gateway URL
 * @returns Absolute gateway URL, or null when the CID cannot be resolved
 *
 * @example
 * resolvePinataGatewayUrl('ipfs://bafyabc');
 * // => 'https://gateway.pinata.cloud/ipfs/bafyabc'
 */
export function resolvePinataGatewayUrl(cid?: string | null): string | null {
   const normalizedCid = normalizeIpfsCid(cid);
   if (!normalizedCid) {
      return null;
   }

   const gatewayBase = envConfig.PINATA_GATEWAY_URL.replace(/\/+$/, '');
   return `${gatewayBase}/${normalizedCid}`;
}
