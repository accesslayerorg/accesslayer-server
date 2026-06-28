type ProtectedRouteHeaderName = 'x-admin-id' | 'x-wallet-address';

export type ProtectedRouteHeaderOverrides = Partial<
   Record<ProtectedRouteHeaderName, string | null | undefined>
>;

const DEFAULT_PROTECTED_ROUTE_HEADERS: Record<
   ProtectedRouteHeaderName,
   string
> = {
   'x-admin-id': 'admin-test-1',
   'x-wallet-address': 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

/**
 * Apply the headers required by protected route tests.
 *
 * Individual headers can be overridden or removed by passing `null`/`undefined`
 * for a specific key.
 */
export function withProtectedRouteHeaders<
   T extends { set(name: string, value: string): T; set(headers: Record<string, string>): T }
>(request: T, overrides: ProtectedRouteHeaderOverrides = {}): T {
   const headers: Partial<Record<ProtectedRouteHeaderName, string>> = {
      ...DEFAULT_PROTECTED_ROUTE_HEADERS,
   };

   (Object.keys(overrides) as ProtectedRouteHeaderName[]).forEach((name) => {
      const value = overrides[name];
      if (value === undefined || value === null) {
         delete headers[name];
         return;
      }

      headers[name] = value;
   });

   return request.set(headers as Record<string, string>);
}
