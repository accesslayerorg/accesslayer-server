import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
   path: string;
   method: string;
   requestId?: string;
   /** Trace ID for this request's call stack; equal to requestId. */
   traceId?: string;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();
