import type { Express } from 'express';
import supertest from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import type Test from 'supertest/lib/test';
import { Keypair } from '@stellar/stellar-base';
import { createHash } from 'crypto';

export type AuthRequestMethod = 'DELETE' | 'PATCH' | 'POST' | 'PUT';

export interface AuthRequestOptions {
   timestamp?: string;
   app?: Express;
}

export interface AuthRequestHeaders extends Record<string, string> {
   'x-wallet-address': string;
   'x-wallet-signature': string;
   'x-timestamp': string;
}

function getDefaultApp(): Express {
   // Lazily load the full application only when callers do not inject a test app.
   // This keeps focused helper tests from compiling app-level dependencies.
   return require('../../app').default as Express;
}

function buildCanonicalMessage(body: unknown, timestamp: string): Buffer {
   const bodyJson = JSON.stringify(body);
   const payload = `${bodyJson}${timestamp}`;
   return createHash('sha256').update(payload, 'utf8').digest();
}

export function buildAuthHeaders(
   body: string | object | undefined,
   walletKeypair: Keypair,
   timestamp = Date.now().toString()
): AuthRequestHeaders {
   const message = buildCanonicalMessage(body, timestamp);
   const signature = walletKeypair.sign(message).toString('base64');

   return {
      'x-wallet-address': walletKeypair.publicKey(),
      'x-wallet-signature': signature,
      'x-timestamp': timestamp,
   };
}

export function buildAuthRequest(
   method: AuthRequestMethod,
   path: string,
   body: string | object | undefined,
   walletKeypair: Keypair,
   options: AuthRequestOptions = {}
): Test {
   const requestApp = options.app ?? getDefaultApp();
   const request = supertest(requestApp) as TestAgent;
   const normalizedMethod =
      method.toLowerCase() as Lowercase<AuthRequestMethod>;
   const headers = buildAuthHeaders(body, walletKeypair, options.timestamp);

   return request[normalizedMethod](path).set(headers).send(body);
}
