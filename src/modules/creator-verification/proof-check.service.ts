// src/modules/creator-verification/proof-check.service.ts
// Proof checks for creator verification (#1324). Each linked account must show
// the application's proof code on a public page. A check passes only when
// every link passes.
//
// Links come from creators, so they are untrusted. Before any request is made,
// a link must be a public HTTPS URL on an accepted host. IP literals, localhost,
// internal names and URLs with credentials are refused. The final URL after
// redirects is checked again. DNS rebinding is not covered by this check, so
// the outbound network path should also block private ranges.

import { isIP } from 'net';
import {
   PROOF_FETCH_TIMEOUT_MS,
   PROOF_MAX_BODY_CHARS,
   PROOF_PROVIDER_HOSTS,
   ProofProvider,
} from './verification.constants';

export interface ProofLink {
   id: string;
   provider: ProofProvider;
   url: string;
}

export interface ProofProviderClient {
   /** Returns the page text for a URL that already passed `isSafeProofUrl`. */
   fetchPage(url: string): Promise<string>;
}

export interface ProofCheckResult {
   passed: boolean;
   results: Array<{ proofId: string; passed: boolean; failureReason: string | null }>;
}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/** True when the hostname names a public host (not an IP, localhost or internal name). */
export function isPublicHostname(hostname: string): boolean {
   const host = hostname.toLowerCase();
   if (host === 'localhost' || !host.includes('.')) return false;
   if (isIP(host) !== 0) return false;
   return !INTERNAL_SUFFIXES.some(suffix => host.endsWith(suffix));
}

/** Parses a public HTTPS URL, or returns null. */
export function parsePublicHttpsUrl(raw: string): URL | null {
   let url: URL;
   try {
      url = new URL(raw);
   } catch {
      return null;
   }
   if (url.protocol !== 'https:') return null;
   if (url.username || url.password) return null;
   if (url.port !== '' && url.port !== '443') return null;
   return isPublicHostname(url.hostname) ? url : null;
}

/**
 * Whether a link may be fetched for a provider. Twitter/X and GitHub links must
 * sit on their own host (or its `www.` form). Website links only need to be a
 * public HTTPS URL.
 */
export function isSafeProofUrl(provider: ProofProvider, raw: string): boolean {
   const url = parsePublicHttpsUrl(raw);
   if (!url) return false;
   if (provider === 'website') return true;

   const host = url.hostname.toLowerCase().replace(/^www\./, '');
   return PROOF_PROVIDER_HOSTS[provider].includes(host);
}

/** Fetches a page over HTTPS with a timeout. Redirects are followed, then re-checked. */
async function fetchPublicPage(url: string): Promise<string> {
   const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(PROOF_FETCH_TIMEOUT_MS),
      headers: {
         'User-Agent': 'AccessLayer-Verification/1.0',
         Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
      },
   });
   if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
   }
   if (!parsePublicHttpsUrl(response.url)) {
      throw new Error('Redirected to a non-public address');
   }
   const text = await response.text();
   return text.slice(0, PROOF_MAX_BODY_CHARS);
}

/** Default client: a plain HTTPS fetch of the public page. */
export const httpProofProviderClient: ProofProviderClient = {
   fetchPage: fetchPublicPage,
};

export const DEFAULT_PROOF_CLIENTS: Readonly<Record<ProofProvider, ProofProviderClient>> = {
   twitter: httpProofProviderClient,
   github: httpProofProviderClient,
   website: httpProofProviderClient,
};

export class ProofCheckService {
   constructor(
      private readonly clients: Readonly<Record<ProofProvider, ProofProviderClient>> = DEFAULT_PROOF_CLIENTS
   ) {}

   /**
    * Checks each link for the proof code. Unsafe links are failed without any
    * request. A link that cannot be loaded fails with a generic reason.
    */
   async verify(application: { proofCode: string; proofs: ProofLink[] }): Promise<ProofCheckResult> {
      const results: ProofCheckResult['results'] = [];

      for (const proof of application.proofs) {
         if (!isSafeProofUrl(proof.provider, proof.url)) {
            results.push({
               proofId: proof.id,
               passed: false,
               failureReason: 'Link is not a public HTTPS page on the expected site',
            });
            continue;
         }

         try {
            const page = await this.clients[proof.provider].fetchPage(proof.url);
            const found = page.includes(application.proofCode);
            results.push({
               proofId: proof.id,
               passed: found,
               failureReason: found ? null : 'Proof code was not found on this page',
            });
         } catch {
            results.push({
               proofId: proof.id,
               passed: false,
               failureReason: 'The page could not be loaded',
            });
         }
      }

      return {
         passed: results.length > 0 && results.every(result => result.passed),
         results,
      };
   }
}

export const proofCheckService = new ProofCheckService();
