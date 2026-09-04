// src/utils/query-cost.utils.ts
// Route-pattern matching and cost computation for the query cost governor
// (#755). Deliberately not path-to-regexp / req.route: the governor is
// mounted as router-level middleware ahead of route resolution, so req.route
// isn't populated yet when it runs — matching has to work off req.path
// directly.

import {
   DEFAULT_QUERY_COST,
   DEFAULT_QUERY_COST_MAP,
} from '../constants/query-cost.constants';

export interface CompiledCostRoute {
   method: string;
   pattern: string;
   regex: RegExp;
   baseCost: number;
}

/** Converts an Express-style `:param` pattern into a matching RegExp. */
function compilePattern(pattern: string): RegExp {
   const escaped = pattern
      .split('/')
      .map(segment =>
         segment.startsWith(':')
            ? '[^/]+'
            : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      )
      .join('/');
   return new RegExp(`^${escaped}/?$`);
}

/** Parses a `"METHOD /pattern"` key into its parts. */
function parseKey(key: string): { method: string; pattern: string } | null {
   const spaceIndex = key.indexOf(' ');
   if (spaceIndex === -1) return null;
   return {
      method: key.slice(0, spaceIndex).toUpperCase(),
      pattern: key.slice(spaceIndex + 1),
   };
}

/**
 * Merges the default cost map with an optional JSON override (from
 * QUERY_COST_MAP_JSON), compiling every entry into a matchable route once at
 * startup rather than on every request.
 */
export function compileCostMap(
   overrideJson?: string,
   defaults: Record<string, number> = DEFAULT_QUERY_COST_MAP
): CompiledCostRoute[] {
   const merged: Record<string, number> = { ...defaults };

   if (overrideJson) {
      let parsed: unknown;
      try {
         parsed = JSON.parse(overrideJson);
      } catch {
         throw new Error(
            'QUERY_COST_MAP_JSON is not valid JSON — expected an object of "METHOD /pattern": cost entries'
         );
      }
      if (
         typeof parsed !== 'object' ||
         parsed === null ||
         Array.isArray(parsed)
      ) {
         throw new Error(
            'QUERY_COST_MAP_JSON must be a JSON object of "METHOD /pattern": cost entries'
         );
      }
      for (const [key, value] of Object.entries(
         parsed as Record<string, unknown>
      )) {
         if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            throw new Error(
               `QUERY_COST_MAP_JSON entry "${key}" must map to a positive number`
            );
         }
         merged[key] = value;
      }
   }

   const compiled: CompiledCostRoute[] = [];
   for (const [key, baseCost] of Object.entries(merged)) {
      const parts = parseKey(key);
      if (!parts) {
         throw new Error(
            `Query cost map key "${key}" must be of the form "METHOD /pattern"`
         );
      }
      compiled.push({
         method: parts.method,
         pattern: parts.pattern,
         regex: compilePattern(parts.pattern),
         baseCost,
      });
   }
   return compiled;
}

/** Finds the first compiled route matching this method+path, if any. */
export function matchCostRoute(
   routes: CompiledCostRoute[],
   method: string,
   path: string
): CompiledCostRoute | null {
   const upperMethod = method.toUpperCase();
   for (const route of routes) {
      if (route.method === upperMethod && route.regex.test(path)) {
         return route;
      }
   }
   return null;
}

/**
 * Computes the cost of a request: the matched route's base cost, or
 * DEFAULT_QUERY_COST when unmatched, multiplied by the `limit` query param
 * when present (issue #755's "parameterised cost" requirement — a caller
 * asking for more rows pays proportionally more).
 */
/** Redis key for a caller's rolling query-cost sorted set. */
export function buildQueryCostRedisKey(identity: string): string {
   return `qcost:${identity}`;
}

export function computeQueryCost(
   matched: CompiledCostRoute | null,
   limitParam: unknown
): number {
   const baseCost = matched?.baseCost ?? DEFAULT_QUERY_COST;
   const limit = Array.isArray(limitParam) ? limitParam[0] : limitParam;
   const parsedLimit =
      typeof limit === 'string' ? Number.parseInt(limit, 10) : NaN;
   if (Number.isFinite(parsedLimit) && parsedLimit > 1) {
      return baseCost * parsedLimit;
   }
   return baseCost;
}
