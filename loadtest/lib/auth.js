/**
 * loadtest/lib/auth.js
 * Generates signed wallet sessions (JWT access tokens and request headers)
 * for authenticated k6 load test scenarios.
 *
 * Fully compatible with both k6 execution environments and standard Node.js runtimes.
 */

import crypto from 'k6/crypto';
import encoding from 'k6/encoding';

/**
 * Base64url encode a string without padding.
 * @param {string} str
 * @returns {string}
 */
export function base64UrlEncode(str) {
   let b64 = '';
   if (encoding && typeof encoding.b64encode === 'function') {
      b64 = encoding.b64encode(str);
   } else if (typeof Buffer !== 'undefined') {
      b64 = Buffer.from(str, 'utf8').toString('base64');
   } else if (typeof btoa === 'function') {
      b64 = btoa(str);
   }
   return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generates a signed wallet session JWT access token.
 *
 * @param {string} walletAddress - Stellar wallet address.
 * @param {object} [options] - Optional overrides.
 * @param {string} [options.secret] - JWT secret.
 * @param {string} [options.issuer] - JWT issuer.
 * @param {number} [options.expiresInSeconds] - Token TTL in seconds.
 * @returns {string} Signed JWT string.
 */
export function generateSignedWalletToken(walletAddress, options = {}) {
   const envSecret =
      typeof __ENV !== 'undefined'
         ? __ENV.JWT_SECRET
         : typeof process !== 'undefined' && process.env
           ? process.env.JWT_SECRET
           : undefined;

   const envIssuer =
      typeof __ENV !== 'undefined'
         ? __ENV.JWT_ISSUER
         : typeof process !== 'undefined' && process.env
           ? process.env.JWT_ISSUER
           : undefined;

   const secret =
      options.secret ||
      envSecret ||
      'accesslayer_default_development_jwt_secret_key_32_bytes';
   const issuer = options.issuer || envIssuer || 'accesslayer-server';
   const ttl = options.expiresInSeconds || 3600;
   const now = Math.floor(Date.now() / 1000);

   const header = {
      alg: 'HS256',
      typ: 'JWT',
   };

   const payload = {
      wallet: walletAddress,
      sub: walletAddress,
      iss: issuer,
      iat: now,
      exp: now + ttl,
   };

   const encodedHeader = base64UrlEncode(JSON.stringify(header));
   const encodedPayload = base64UrlEncode(JSON.stringify(payload));
   const message = `${encodedHeader}.${encodedPayload}`;

   let signature = '';
   if (crypto && typeof crypto.hmac === 'function') {
      signature = crypto.hmac('sha256', secret, message, 'base64rawurl');
   } else {
      // Node.js fallback
      try {
         const nodeCrypto = require('crypto');
         signature = nodeCrypto
            .createHmac('sha256', secret)
            .update(message)
            .digest('base64url');
      } catch (_e) {
         throw new Error('No HMAC provider available');
      }
   }

   return `${message}.${signature}`;
}

/**
 * Returns HTTP headers map for an authenticated wallet request.
 *
 * @param {string} walletAddress - Stellar wallet address.
 * @param {object} [options] - Optional token parameters.
 * @returns {Record<string, string>} Request headers.
 */
export function getAuthHeaders(walletAddress, options = {}) {
   const token = generateSignedWalletToken(walletAddress, options);
   return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-wallet-address': walletAddress,
   };
}

/**
 * Creates a signed wallet session object.
 *
 * @param {string} walletAddress - Stellar wallet address.
 * @param {object} [options] - Optional token parameters.
 * @returns {{ wallet: string, token: string, headers: Record<string, string> }}
 */
export function createWalletSession(walletAddress, options = {}) {
   const token = generateSignedWalletToken(walletAddress, options);
   return {
      wallet: walletAddress,
      token,
      headers: {
         Authorization: `Bearer ${token}`,
         'Content-Type': 'application/json',
         'x-wallet-address': walletAddress,
      },
   };
}
