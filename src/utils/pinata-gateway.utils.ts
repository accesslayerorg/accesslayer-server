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
