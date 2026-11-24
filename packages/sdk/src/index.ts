import createClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './generated/schema.js';

export type AccessLayerClient = ReturnType<typeof createClient<paths>>;

export interface CreateAccessLayerClientOptions extends ClientOptions {
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
}

export function createAccessLayerClient(options: CreateAccessLayerClientOptions): AccessLayerClient {
  const { apiKey, bearerToken, ...rest } = options;
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  return createClient<paths>({
    ...rest,
    headers: { ...headers, ...(rest.headers as Record<string, string> | undefined) },
  });
}

export async function paginateCursor<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string | null }>
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (!page.nextCursor) return items;
    cursor = page.nextCursor;
  }
}

export type ApiError = {
  status: number;
  code?: string;
  message: string;
  details?: unknown;
};

export function toApiError(status: number, error: unknown): ApiError {
  const e = (error ?? {}) as Record<string, unknown>;
  return {
    status,
    code: typeof e.code === 'string' ? e.code : undefined,
    message: typeof e.message === 'string' ? e.message : 'Request failed',
    details: e.details,
  };
}

export type { paths };
