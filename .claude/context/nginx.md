# Nginx — shared helpers and conflict rules

> Split out of `.claude/CLAUDE.md` (which points here). Read on demand — keep the
> always-loaded CLAUDE.md lean; add new detail HERE, not there.

## Nginx Configuration — Shared Helpers & Conflict Prevention
Nginx loads ALL `/etc/nginx/conf.d/*.conf` into the http context — two scripts defining the
same `limit_req_zone` differently → nginx error. All rate-limit zone creation goes through one
primitive in `scripts/lib/nginx_shared_helpers.sh`:
```bash
nginx_ensure_rate_limit_zone <zone_name> <rate> [size=10m] [conf_basename] [force]
```
It grep-guards existing definitions and writes `/etc/nginx/conf.d/<conf_basename>.conf` if
missing (no-op if the file exists — delete the file to regenerate). A non-empty 5th arg
(`force`) re-asserts the rate from the toolkit source on every run instead, so editing the
value in the lib actually reaches an installed box; `nginx_ensure_grin_api_zone` passes it.

- **SHARED zones** (multiple scripts) → add a named wrapper in the lib so every caller passes
  identical args → byte-identical output → last-write-wins is safe. Current: `grin_api`
  (`nginx_ensure_grin_api_zone`, `300r/m`, used by Scripts 04 + 06).
- **SCRIPT-SPECIFIC zones** → call the primitive (or `nginx_ensure_rate_limit_zones
  <conf_basename> <zone:rate[:size]> ...`) with the script's own params. Name conf files with a
  `script##-` prefix (`script04-…`, `script07-…`). The owning script's detail stays in memory.
- `grin_conn` (limit_conn, Script 04) → `/etc/nginx/conf.d/grin-conn-limit.conf` via
  `nginx_ensure_conn_limit_zone`. **Never patch a zone inline into `nginx.conf`** — a Debian
  nginx package upgrade resets `nginx.conf` to default, wiping an inline zone while the site
  config that references it survives → boot fails "zero size shared memory zone".

### Rules
1. **Never write `limit_req_zone …` inline** — always the primitive or a named wrapper.
2. **Same path + same content = safe** (byte-identical writes; named wrappers enforce this).
3. **Zone names must be globally unique.** Before adding: `grep -r "zone=name_here" scripts/ lib/`.
4. **`nginx -t` before any `systemctl reload nginx`.**
5. **Let's Encrypt bootstrap:** never write a vhost referencing `/etc/letsencrypt/live/<domain>/…`
   before the cert exists (`nginx -t` hard-fails). Pattern: HTTP-only vhost → reload →
   `certbot --nginx` → then write the full SSL vhost. Include `options-ssl-nginx.conf` only when
   the file exists; never put shell syntax (`2>/dev/null`) inside an nginx config.

