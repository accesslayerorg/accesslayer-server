import { envConfig } from '../config';
import { formatIsoTimestamp } from './iso-timestamp.utils';
import { logger } from './logger.utils';
import { elapsedMs, startTimer } from './monotonic-clock.utils';
import { RpcTimeoutError, withRpcTimeout } from './rpc-timeout.utils';

export type HorizonHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';

export interface HorizonRequestInit {
   method?: HorizonHttpMethod;
   headers?: Record<string, string>;
   body?: string;
   timeoutMs?: number;
}

/**
 * Normalises a Horizon path for logging (pathname + query, no origin).
 */
export function normalizeHorizonEndpoint(endpoint: string): string {
   if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      const url = new URL(endpoint);
      return `${url.pathname}${url.search}`;
   }
   return endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
}

function buildHorizonUrl(endpoint: string): string {
   const path = normalizeHorizonEndpoint(endpoint);
   const base = envConfig.STELLAR_HORIZON_URL.replace(/\/$/, '');
   return `${base}${path}`;
}

function nonNegativeResponseTimeMs(
   timer: ReturnType<typeof startTimer>
): number {
   return Math.max(0, Math.round(elapsedMs(timer)));
}

/**
 * Performs an outbound Horizon API request and emits structured logs after the
 * response is received. Request bodies and authorization headers are never logged.
 */
export async function horizonRequest(
   endpoint: string,
   init: HorizonRequestInit = {}
): Promise<Response> {
   const method = init.method ?? 'GET';
   const horizonEndpoint = normalizeHorizonEndpoint(endpoint);
   const calledAt = formatIsoTimestamp(new Date());
   const timer = startTimer();
   const url = buildHorizonUrl(endpoint);

   const doFetch = () =>
      fetch(url, {
         method,
         headers: init.headers,
         body: init.body,
      });

   try {
      const response = await withRpcTimeout(
         `horizon:${method}:${horizonEndpoint}`,
         doFetch,
         init.timeoutMs
      );

      logger.info(
         {
            horizon_endpoint: horizonEndpoint,
            method,
            status_code: response.status,
            response_time_ms: nonNegativeResponseTimeMs(timer),
            called_at: calledAt,
         },
         'Horizon API call completed'
      );

      return response;
   } catch (err) {
      if (err instanceof RpcTimeoutError) {
         logger.warn(
            {
               horizon_endpoint: horizonEndpoint,
               method,
               response_time_ms: nonNegativeResponseTimeMs(timer),
               called_at: calledAt,
               timed_out: true,
            },
            'Horizon API call timed out'
         );
      }
      throw err;
   }
}
