import http from 'k6/http';
import { check, sleep } from 'k6';
import { getAuthHeaders } from './lib/auth.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WALLET_ADDRESS =
   __ENV.WALLET_ADDRESS ||
   'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
const KEY_ID = __ENV.KEY_ID || 'seed-key-00000';

export const options = {
   scenarios: {
      keys_list: {
         executor: 'constant-vus',
         vus: 5,
         duration: '60s',
         exec: 'keysListScenario',
      },
      keys_detail: {
         executor: 'constant-vus',
         vus: 5,
         duration: '60s',
         exec: 'keysDetailScenario',
      },
      wallet_holdings: {
         executor: 'constant-vus',
         vus: 5,
         duration: '60s',
         exec: 'walletHoldingsScenario',
      },
      orders: {
         executor: 'constant-vus',
         vus: 5,
         duration: '60s',
         exec: 'ordersScenario',
      },
   },
   thresholds: {
      // Read routes: p95 under 300ms, error rate under 1%
      'http_req_duration{type:read}': ['p(95)<300'],
      'http_req_failed{type:read}': ['rate<0.01'],

      // Write routes: p95 under 600ms, error rate under 1%
      'http_req_duration{type:write}': ['p(95)<600'],
      'http_req_failed{type:write}': ['rate<0.01'],

      // Overall test sanity
      checks: ['rate>0.99'],
   },
};

export function keysListScenario() {
   const res = http.get(`${BASE_URL}/v1/keys?limit=20`, {
      tags: { type: 'read', name: 'GET /v1/keys' },
   });

   check(res, {
      'GET /v1/keys status 200': r => r.status === 200,
      'GET /v1/keys has data': r => {
         try {
            const body = JSON.parse(r.body);
            return Array.isArray(body.data?.items || body.data);
         } catch (_e) {
            return false;
         }
      },
   });

   sleep(0.05);
}

export function keysDetailScenario() {
   const res = http.get(`${BASE_URL}/v1/keys/${KEY_ID}`, {
      tags: { type: 'read', name: 'GET /v1/keys/:id' },
   });

   check(res, {
      'GET /v1/keys/:id status 200': r => r.status === 200,
      'GET /v1/keys/:id has id': r => {
         try {
            const body = JSON.parse(r.body);
            return !!(body.data?.id || body.data?.creatorId || body.data?.profile?.id);
         } catch (_e) {
            return false;
         }
      },
   });

   sleep(0.05);
}

export function walletHoldingsScenario() {
   const res = http.get(`${BASE_URL}/v1/wallets/${WALLET_ADDRESS}/holdings`, {
      tags: { type: 'read', name: 'GET /v1/wallets/:address/holdings' },
   });

   check(res, {
      'GET /v1/wallets/:address/holdings status 200': r => r.status === 200,
      'GET /v1/wallets/:address/holdings has items': r => {
         try {
            const body = JSON.parse(r.body);
            return Array.isArray(body.data?.items);
         } catch (_e) {
            return false;
         }
      },
   });

   sleep(0.05);
}

export function ordersScenario() {
   const headers = getAuthHeaders(WALLET_ADDRESS);
   const payload = JSON.stringify({
      keyId: KEY_ID,
      quantity: 1,
      side: 'buy',
      targetPrice: 0.5,
      price: 0.5,
   });

   const res = http.post(`${BASE_URL}/v1/orders`, payload, {
      headers,
      tags: { type: 'write', name: 'POST /v1/orders' },
   });

   check(res, {
      'POST /v1/orders status 201': r => r.status === 201,
      'POST /v1/orders order placed': r => {
         try {
            const body = JSON.parse(r.body);
            return !!(body.data?.orderId || body.data?.tradeId || body.data?.id);
         } catch (_e) {
            return false;
         }
      },
   });

   sleep(0.05);
}

export function handleSummary(data) {
   return {
      'loadtest-summary.json': JSON.stringify(data, null, 2),
   };
}
