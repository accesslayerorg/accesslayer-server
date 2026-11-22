import http from 'k6/http';
import { check, sleep } from 'k6';
import { getAuthHeaders } from './lib/auth.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WALLET_ADDRESS =
   __ENV.WALLET_ADDRESS ||
   'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
const KEY_ID = __ENV.KEY_ID || 'seed-key-00000';

export const options = {
   vus: 5,
   duration: '30s',
   thresholds: {
      'http_req_duration{type:write}': ['p(95)<600'],
      'http_req_failed{type:write}': ['rate<0.01'],
   },
};

export default function () {
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
      'status is 201': r => r.status === 201,
      'order created': r => {
         try {
            const body = JSON.parse(r.body);
            return !!(body.data?.orderId || body.data?.tradeId || body.data?.id);
         } catch (_e) {
            return false;
         }
      },
   });

   sleep(0.1);
}
