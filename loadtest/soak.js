import http from 'k6/http';
import { check, sleep } from 'k6';
import { getAuthHeaders } from './lib/auth.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WALLET_ADDRESS =
   __ENV.WALLET_ADDRESS ||
   'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
const KEY_ID = __ENV.KEY_ID || 'seed-key-00000';
const DURATION = __ENV.SOAK_DURATION || '30m';

export const options = {
   stages: [
      { duration: '2m', target: 20 }, // Ramp-up
      { duration: DURATION, target: 20 }, // Steady soak load
      { duration: '2m', target: 0 }, // Ramp-down
   ],
   thresholds: {
      'http_req_duration{type:read}': ['p(95)<300'],
      'http_req_failed{type:read}': ['rate<0.01'],
      'http_req_duration{type:write}': ['p(95)<600'],
      'http_req_failed{type:write}': ['rate<0.01'],
      checks: ['rate>0.99'],
   },
};

export default function () {
   // 1. Read keys list
   http.get(`${BASE_URL}/v1/keys?limit=20`, {
      tags: { type: 'read', name: 'GET /v1/keys' },
   });

   // 2. Read key details
   http.get(`${BASE_URL}/v1/keys/${KEY_ID}`, {
      tags: { type: 'read', name: 'GET /v1/keys/:id' },
   });

   // 3. Read wallet holdings
   http.get(`${BASE_URL}/v1/wallets/${WALLET_ADDRESS}/holdings`, {
      tags: { type: 'read', name: 'GET /v1/wallets/:address/holdings' },
   });

   // 4. Authenticated order write
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
      'order status 201': r => r.status === 201,
   });

   sleep(0.5);
}

export function handleSummary(data) {
   return {
      'loadtest-summary.json': JSON.stringify(data, null, 2),
   };
}
