// src/constants/query-cost.constants.ts
// Default route->cost map for the query cost governor (#755).
//
// Keys are `${METHOD} ${pattern}`, where `pattern` uses Express-style
// `:param` segments (matched via src/utils/query-cost.utils.ts, not
// req.route — the governor runs as router-level middleware, before Express
// resolves the specific route, so req.route isn't populated yet).
//
// The issue's own example routes (`GET /search`, `GET /creators/:id/history`)
// don't exist verbatim in this codebase; substituted for the closest real
// equivalents (`GET /keys/search`, `GET /creators/:id/stats`) — see the PR
// description for the full mapping rationale.
export const DEFAULT_QUERY_COST_MAP: Record<string, number> = {
   'GET /creators': 1,
   'GET /creators/:id/holders': 3,
   'GET /creators/:id/stats': 2,
   'GET /keys/search': 5,
};

/** Cost applied to any authenticated route with no explicit entry in the map. */
export const DEFAULT_QUERY_COST = 1;

/**
 * Route patterns exempt from query cost governance entirely: health checks
 * (must stay reachable regardless of load) and the governor's own internal
 * management routes (resetting a wallet's budget must never itself be
 * throttled by that same budget).
 */
export const QUERY_COST_EXEMPT_PATH_PREFIXES = ['/health', '/internal/qcost'];
