# Sitemap and robots.txt

Search engines discover creator pages through server-generated sitemaps (#1242).

| Route | Description |
| --- | --- |
| `GET /sitemap.xml` | Sitemap index, one `<sitemap>` entry per page |
| `GET /sitemaps/creators-:page.xml` | Creator URLs, at most 10,000 per file, `page` starts at 1 |
| `GET /robots.txt` | Disallows `/api/` and `/internal/`, points at `/sitemap.xml` |

## Behaviour

- URLs are `<PUBLIC_SITE_URL origin>/creators/<handle>`; `lastmod` is the creator's `updatedAt`.
- Excluded: keys whose `status` is not `Active`, deprecated or retired keys (`deprecatedAt` set), keys flagged for sunset (`sunsetFlaggedAt` set) and keys with an unexpired freeze.
- Pages are ordered by creator id, so a page is stable between requests. A page number past the last page returns `404`.
- The index and each page are cached in Redis for one hour (`sitemap:v1:*`). If Redis is unavailable the sitemap is generated on each request.
- `PUBLIC_SITE_URL` is required; the server refuses to start without it.

Code: `src/modules/sitemap/`.
