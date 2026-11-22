import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const KEY_ID = __ENV.KEY_ID || 'seed-key-00000';

export const options = {
   vus: 10,
   duration: '30s',
   thresholds: {
      'http_req_duration{type:read}': ['p(95)<300'],
      'http_req_failed{type:read}': ['rate<0.01'],
   },
};

export default function () {
   const res = http.get(`${BASE_URL}/v1/keys/${KEY_ID}`, {
      tags: { type: 'read', name: 'GET /v1/keys/:id' },
   });

   check(res, {
      'status is 200': r => r.status === 200,
      'returned key profile': r => {
         try {
            const body = JSON.parse(r.body);
            return !!(body.data?.id || body.data?.creatorId || body.data?.profile?.id);
         } catch (_e) {
            return false;
         }
      },
   });

   sleep(0.1);
}
