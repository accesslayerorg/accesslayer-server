import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WALLET_ADDRESS =
   __ENV.WALLET_ADDRESS ||
   'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';

export const options = {
   vus: 10,
   duration: '30s',
   thresholds: {
      'http_req_duration{type:read}': ['p(95)<300'],
      'http_req_failed{type:read}': ['rate<0.01'],
   },
};

export default function () {
   const res = http.get(`${BASE_URL}/v1/wallets/${WALLET_ADDRESS}/holdings`, {
      tags: { type: 'read', name: 'GET /v1/wallets/:address/holdings' },
   });

   check(res, {
      'status is 200': r => r.status === 200,
      'has holdings list': r => {
         try {
            const body = JSON.parse(r.body);
            return Array.isArray(body.data?.items);
         } catch (_e) {
            return false;
         }
      },
   });

   sleep(0.1);
}
