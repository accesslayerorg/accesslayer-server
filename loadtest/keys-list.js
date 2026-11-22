import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
   vus: 10,
   duration: '30s',
   thresholds: {
      'http_req_duration{type:read}': ['p(95)<300'],
      'http_req_failed{type:read}': ['rate<0.01'],
   },
};

export default function () {
   const res = http.get(`${BASE_URL}/v1/keys?limit=20`, {
      tags: { type: 'read', name: 'GET /v1/keys' },
   });

   check(res, {
      'status is 200': r => r.status === 200,
      'has valid payload': r => {
         try {
            const body = JSON.parse(r.body);
            return Array.isArray(body.data?.items || body.data);
         } catch (_e) {
            return false;
         }
      },
   });

   sleep(0.1);
}
