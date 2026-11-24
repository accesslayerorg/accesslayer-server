# Region Restrictions

Some features cannot be offered in some countries. Restrictions are stored as rules, checked by the `regionGuard(feature)` middleware, and explained to clients by `GET /api/v1/regions/me` (#1354).

## How a request is placed

- **Detected country.** The client IP is looked up in a local GeoLite2-Country database (`GEOIP_DB_PATH`). When no database is configured, the file is missing, or the address is private, the detected country is `null`.
- **Declared country.** Clients may send an `X-Declared-Country` header with an ISO 3166-1 alpha-2 code. An invalid value is rejected with 400.

A feature is restricted when a rule exists for it in either country. Declaring a country can add a restriction but can never remove one that applies to the detected country.

## Client IP and proxies

`X-Forwarded-For` is read only when the connection comes from an address listed in `TRUSTED_PROXIES` (comma-separated IPs or CIDRs, IPv4 or IPv6). The header is walked from right to left, skipping trusted proxies, and the first untrusted hop is the client. With `TRUSTED_PROXIES` unset, the connection address is always used, so a forwarded header sent by a client has no effect.

## Rules

| Field         | Meaning                                                           |
| ------------- | ----------------------------------------------------------------- |
| `feature`     | Lower-case identifier passed to `regionGuard`, e.g. `key_trading` |
| `countryCode` | ISO 3166-1 alpha-2 code, stored upper-case                        |
| `action`      | `BLOCK`                                                           |
| `reason`      | Neutral upper-case reason code returned to blocked callers        |

Admin routes, all requiring an admin JWT:

| Method   | Path                              | Purpose       |
| -------- | --------------------------------- | ------------- |
| `GET`    | `/api/v1/admin/regions/rules`     | List rules    |
| `POST`   | `/api/v1/admin/regions/rules`     | Create a rule |
| `PATCH`  | `/api/v1/admin/regions/rules/:id` | Update a rule |
| `DELETE` | `/api/v1/admin/regions/rules/:id` | Delete a rule |

Each instance caches rules in memory for 60 seconds and clears its cache on its own writes, so a change takes effect everywhere within a minute.

## Guarding a feature

```ts
import { regionGuard } from '../../middlewares/region-guard.middleware';

router.post('/buy', regionGuard('key_trading'), handler);
```

A restricted caller receives HTTP 451 with error code `REGION_RESTRICTED` and the rule's reason code in `error.details[0].message`. If the rules cannot be loaded, the guard returns 503 and does not let the request through.

## Privacy

Raw IP addresses are never logged or stored. Every guard decision is logged with an HMAC-SHA256 hash of the IP keyed by `IP_HASH_SECRET` (falling back to `JWT_SECRET`), together with the feature, decision, reason code and countries.

## Refreshing the database monthly

MaxMind updates GeoLite2-Country every week. Refresh it at least once a month with a free MaxMind account:

```bash
MAXMIND_ACCOUNT_ID=... MAXMIND_LICENSE_KEY=... GEOIP_DB_PATH=./data/GeoLite2-Country.mmdb \
   pnpm exec ts-node --transpile-only scripts/refresh-geoip-db.ts
```

Schedule it with cron on the first day of each month, for example `0 4 1 * *`. The script checks the archive's SHA-256 against MaxMind's checksum, opens the extracted database to confirm it is valid, writes it next to the target and renames it into place. Running servers pick up the new file through their file watcher without a restart, and a failed refresh leaves the previous database in place. Do not commit `.mmdb` files.
