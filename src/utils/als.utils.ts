import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  path: string;
  method: string;
  requestId?: string;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();
