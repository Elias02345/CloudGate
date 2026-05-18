# CloudGate — AI Agent & Shell-API Guide

> **For LLMs, coding assistants, and humans operating CloudGate from a terminal.**
>
> This document is the single source of truth for using CloudGate's REST API
> from outside the browser. It's structured for reading by AI agents:
> a quickstart, a glossary, then numbered recipes you can execute step by
> step. Everything is copy-paste-fertig.

## Quickstart (3 commands)

```bash
# 1) Create an API key in the WebUI: Settings → API keys → Create key (scope=admin).
#    Save the cgk_... value. It is shown ONCE.

# 2) Set it in your shell
export CLOUDGATE_KEY="cgk_a3f9b201_x8sH9p2Lm0qRtVwY1zA3bC5dE7fG9hI0"
export CLOUDGATE_URL="http://192.168.1.20"   # or https://your-host

# 3) Verify
curl -fsSL -H "Authorization: Bearer $CLOUDGATE_KEY" "$CLOUDGATE_URL/api/health" | jq
```

Expected response: `{"status":"ok","version":"0.x.y",...}`.

If `health` returns 200 but anything else is `401 INVALID_API_KEY`, the key
prefix is wrong or it's been revoked. Issue a fresh one in the WebUI.

---

## Authentication

| Header | Form | Used by |
|---|---|---|
| `Authorization: Bearer cgk_<prefix>_<secret>` | Long-lived API key | curl, AI agents, scripts |
| `Authorization: Bearer <JWT>` | Short-lived JWT (8h) | Browser SPA only |

**Key format.** `cgk_<8charPrefix>_<32charSecret>`. The prefix part is
stored plaintext in CloudGate's DB for O(1) lookup; the secret is hashed
with SHA-256 and never stored in plaintext. Don't try to construct keys
yourself — issue them via the WebUI.

**Scopes.**
- `admin` — full read + write. Equivalent to a logged-in admin user.
- `read` — GET / HEAD / OPTIONS only. Any non-GET request returns
  `403 INSUFFICIENT_SCOPE`.

**Rate limits per key.**
- admin: 60 req / minute / key
- read: 120 req / minute / key

When you exceed the limit you get `429 RATE_LIMITED` with `Retry-After`
in the response headers. Back off — don't hammer.

**Key management is browser-only.** API keys cannot manage other API keys
(prevents lateral movement after a leak). To rotate or revoke, log into
the WebUI as a human and use Settings → API keys.

---

## Resource Model

CloudGate is a Cloudflare-Tunnel manager. Mental model:

```
  Cloudflare Account   (your CF identity, holds the API token)
        │
        ├── Zone               (a domain you own, e.g. example.com)
        │     └── Host         (e.g. immich.example.com → 192.168.1.10:2283)
        │
        └── Tunnel             (a long-lived cloudflared daemon process)
              └── Host         (a host can route through this tunnel)
```

Glossary:
- **Account** — a Cloudflare account, identified by `account_tag` (UUID).
  Holds an encrypted API token. You can have multiple per CloudGate.
- **Zone** — a Cloudflare-managed domain (e.g. `example.com`). Belongs to
  one Account.
- **Tunnel** — a `cloudflared` daemon spawned by CloudGate. Has a UUID,
  a credentials file (`/data/cloudflared/<uuid>.json`), and a status
  (`stopped` / `starting` / `running` / `error`).
- **Host** — what you actually expose. Has a public hostname (must end in
  a Zone you own), a forward target (internal IP:port), and a `mode`:
  - `cloudflare_tunnel` — routes through a CloudGate-managed tunnel
  - `local_nginx` — direct nginx reverse proxy on this machine (you need
    a public IP for this mode)

Hosts deploy **async**: the API call returns 201 immediately, then CloudGate
writes the tunnel config, reloads cloudflared (SIGHUP), creates the DNS
CNAME at Cloudflare, and updates `last_deployed_at`. Poll until that
field is set or `last_error` is non-null.

---

## Common Workflows (Numbered Recipes)

### Recipe A — Add CF account, create tunnel, add first host

```bash
# Make sure you have a Cloudflare API token with these scopes:
#   - Account → Cloudflare Tunnel → Edit
#   - Zone    → DNS → Edit
#   - Zone    → Zone → Read
# Create at: https://dash.cloudflare.com/profile/api-tokens

# 1. Add the CF account (validates the token + caches zones)
curl -fsSL -X POST \
  -H "Authorization: Bearer $CLOUDGATE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label":"main","api_token":"<your-cf-token>"}' \
  "$CLOUDGATE_URL/api/cloudflare/accounts" | jq

# 2. List zones (verify which domains are available)
ACCOUNT_ID=$(curl -fsSL -H "Authorization: Bearer $CLOUDGATE_KEY" \
  "$CLOUDGATE_URL/api/cloudflare/accounts" | jq '.accounts[0].id')
curl -fsSL -H "Authorization: Bearer $CLOUDGATE_KEY" \
  "$CLOUDGATE_URL/api/cloudflare/accounts/$ACCOUNT_ID/zones" | jq '.zones[].name'

# 3. Create a tunnel
curl -fsSL -X POST \
  -H "Authorization: Bearer $CLOUDGATE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"cloudflare_account_id\":$ACCOUNT_ID,\"name\":\"homelab\"}" \
  "$CLOUDGATE_URL/api/tunnels" | jq

# 4. Add a host — internal service immich.example.com → 192.168.1.10:2283
curl -fsSL -X POST \
  -H "Authorization: Bearer $CLOUDGATE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "hostname":"immich.example.com",
    "forward_host":"192.168.1.10",
    "forward_port":2283,
    "forward_scheme":"http",
    "mode":"cloudflare_tunnel"
  }' \
  "$CLOUDGATE_URL/api/hosts" | jq

# 5. Wait for deploy (poll until last_deployed_at is set OR last_error is non-null)
HOST_ID=$(curl -fsSL -H "Authorization: Bearer $CLOUDGATE_KEY" \
  "$CLOUDGATE_URL/api/hosts" | jq '.hosts[-1].id')
for i in $(seq 1 30); do
  RESP=$(curl -fsSL -H "Authorization: Bearer $CLOUDGATE_KEY" \
    "$CLOUDGATE_URL/api/hosts/$HOST_ID")
  ERR=$(echo "$RESP" | jq -r '.last_error // ""')
  DEPLOYED=$(echo "$RESP" | jq -r '.last_deployed_at // ""')
  if [[ -n "$ERR" ]]; then echo "FAIL: $ERR"; break; fi
  if [[ -n "$DEPLOYED" ]]; then echo "Deployed at $DEPLOYED"; break; fi
  sleep 2
done

# 6. Verify it's actually reachable (optional — DNS may need a moment)
curl -fsI https://immich.example.com
```

### Recipe B — Bulk import from a CSV

```bash
cat > /tmp/hosts.csv <<'EOF'
hostname,forward_host,forward_port
a.example.com,192.168.1.10,8080
b.example.com,192.168.1.11,8081
c.example.com,192.168.1.12,8082
EOF

TUNNEL_ID=$(curl -fsSL -H "Authorization: Bearer $CLOUDGATE_KEY" \
  "$CLOUDGATE_URL/api/tunnels" | jq '.tunnels[0].id')
ZONE_ID=$(curl -fsSL -H "Authorization: Bearer $CLOUDGATE_KEY" \
  "$CLOUDGATE_URL/api/cloudflare/accounts/$ACCOUNT_ID/zones" | jq '.zones[0].id')

curl -fsSL -X POST \
  -H "Authorization: Bearer $CLOUDGATE_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -Rsc --arg t "$TUNNEL_ID" --arg z "$ZONE_ID" \
    'split("\n") | map(select(. != "")) |
     {rows: .[1:] | map(split(",") | {
       hostname:.[0], forward_host:.[1], forward_port:(.[2]|tonumber),
       tunnel_id:($t|tonumber), cf_zone_id:($z|tonumber)
     })}' < /tmp/hosts.csv)" \
  "$CLOUDGATE_URL/api/hosts/bulk-import" | jq
```

### Recipe C — Diagnose + restart a broken tunnel

```bash
# Get all tunnels with their status
curl -fsSL -H "Authorization: Bearer $CLOUDGATE_KEY" \
  "$CLOUDGATE_URL/api/tunnels" | \
  jq '.tunnels[] | {id, name, live_status, last_status_at}'

# Pull the last 50 log lines from a specific tunnel
TUNNEL_DB_ID=1
curl -fsSL -H "Authorization: Bearer $CLOUDGATE_KEY" \
  "$CLOUDGATE_URL/api/tunnels/$TUNNEL_DB_ID/logs?lines=50" | jq -r '.logs[]'

# Restart it (kills + respawns cloudflared, ~5s outage)
curl -fsSL -X POST -H "Authorization: Bearer $CLOUDGATE_KEY" \
  "$CLOUDGATE_URL/api/tunnels/$TUNNEL_DB_ID/restart"

# Wait until status is "running" again
for i in $(seq 1 20); do
  S=$(curl -fsSL -H "Authorization: Bearer $CLOUDGATE_KEY" \
    "$CLOUDGATE_URL/api/tunnels" | jq -r ".tunnels[] | select(.id == $TUNNEL_DB_ID) | .live_status")
  if [[ "$S" == "running" ]]; then echo "OK"; break; fi
  sleep 2
done
```

### Recipe D — Issue Let's Encrypt cert for a local_nginx host

```bash
# Only applicable to hosts in mode=local_nginx (NOT cloudflare_tunnel)
HOST_NAME="api.example.com"
curl -fsSL -X POST \
  -H "Authorization: Bearer $CLOUDGATE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"hostname\":\"$HOST_NAME\"}" \
  "$CLOUDGATE_URL/api/acme/issue" | jq
# CloudGate creates a TXT record in Cloudflare, waits for propagation, runs
# DNS-01 challenge, saves the cert under /data/nginx/certs/. ~30-60s end-to-end.
```

### Recipe E — Export an encrypted backup

```bash
PASSPHRASE="my-very-strong-passphrase-123!"
curl -fsSL \
  -H "Authorization: Bearer $CLOUDGATE_KEY" \
  -o "cloudgate-backup-$(date +%Y%m%d).cgbk" \
  "$CLOUDGATE_URL/api/backup?passphrase=$(printf '%s' "$PASSPHRASE" | jq -sRr @uri)"

# Verify by checking size + magic bytes
ls -lh cloudgate-backup-*.cgbk
file cloudgate-backup-*.cgbk
```

### Recipe F — Read audit log, filter

```bash
# Last 20 host operations
curl -fsSL -H "Authorization: Bearer $CLOUDGATE_KEY" \
  "$CLOUDGATE_URL/api/audit?action=host.created&limit=20" | \
  jq '.data[] | {at: .created_at, by: .user_id, ip, meta}'

# Everything by user 1 in the last hour
SINCE=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S)
curl -fsSL -H "Authorization: Bearer $CLOUDGATE_KEY" \
  "$CLOUDGATE_URL/api/audit?user_id=1&since=$SINCE&limit=50" | jq '.data'
```

### Recipe G — Health-check + auto-recovery

A common AI-agent loop: poll deep health, restart what's broken.

```bash
HEALTH=$(curl -fsSL -H "Authorization: Bearer $CLOUDGATE_KEY" \
  "$CLOUDGATE_URL/api/health/deep")
echo "$HEALTH" | jq '.checks'

# If cloudflared check failed AND we have running tunnels in DB, restart them.
CF_OK=$(echo "$HEALTH" | jq '.checks.cloudflared.ok')
if [[ "$CF_OK" == "false" ]]; then
  echo "cloudflared subsystem unhealthy — restarting tunnels"
  TUNNELS=$(curl -fsSL -H "Authorization: Bearer $CLOUDGATE_KEY" \
    "$CLOUDGATE_URL/api/tunnels" | jq -r '.tunnels[] | select(.live_status != "stopped") | .id')
  for t in $TUNNELS; do
    curl -fsSL -X POST -H "Authorization: Bearer $CLOUDGATE_KEY" \
      "$CLOUDGATE_URL/api/tunnels/$t/restart"
  done
fi
```

---

## Endpoint Catalog

Run `curl -s "$CLOUDGATE_URL/api/openapi.json" | jq` for the machine-readable
list. Highlights for agents:

| Verb · Path | Purpose |
|---|---|
| `GET    /api/health` | Light healthcheck — no auth |
| `GET    /api/health/deep` | Subsystem checks (db, secrets, cloudflared, disk, github) |
| `GET    /api/openapi.json` | OpenAPI 3.1 spec (no auth) |
| `GET    /api/hosts` | List all hosts (your user's) |
| `GET    /api/hosts/:id` | One host with last_deployed_at + last_error |
| `POST   /api/hosts` | Create + async-deploy |
| `PUT    /api/hosts/:id` | Update + re-deploy |
| `POST   /api/hosts/:id/toggle` | Enable / disable |
| `DELETE /api/hosts/:id` | Undeploy + remove |
| `GET    /api/hosts/:id/test` | HEAD-probe the public hostname |
| `POST   /api/hosts/bulk-import` | CSV-style bulk create |
| `GET    /api/tunnels` | List tunnels with live status |
| `POST   /api/tunnels` | Create + start daemon |
| `POST   /api/tunnels/:id/restart` | Restart daemon (SIGHUP → respawn) |
| `GET    /api/tunnels/:id/logs?lines=100` | Tail daemon logs |
| `DELETE /api/tunnels/:id` | Stop daemon + delete from CF |
| `GET    /api/cloudflare/accounts` | List CF accounts |
| `POST   /api/cloudflare/accounts` | Add CF account by API token |
| `DELETE /api/cloudflare/accounts/:id` | Remove (cascades zones, tunnels) |
| `POST   /api/cloudflare/accounts/:id/sync` | Refresh cached zone list |
| `GET    /api/cloudflare/accounts/:id/zones` | List cached zones |
| `GET    /api/audit?action=...&user_id=...&limit=N` | Audit log |
| `GET    /api/backup?passphrase=X` | Stream encrypted backup (.cgbk) |
| `GET    /api/updates` | Updater state (current_version, latest, mode) |
| `POST   /api/updates/check` | Force check now |
| `POST   /api/acme/issue` | Issue Let's Encrypt cert for local_nginx host |
| `GET    /api/events?topics=host,tunnel` | SSE stream of internal events |

---

## SSE Events

Subscribe to internal events for live updates instead of polling:

```bash
# Tail all host + tunnel events
curl -N -H "Authorization: Bearer $CLOUDGATE_KEY" \
  "$CLOUDGATE_URL/api/events?topics=host,tunnel"
```

Wire format: one event per line, lines are `data: {json}\n\n`.

Topics:
- `host.*` — `host.created`, `host.updated`, `host.deployed`, `host.delete`, `host.deploy_failed`
- `tunnel.*` — `tunnel.created`, `tunnel.started`, `tunnel.stopped`, `tunnel.crashed`
- `update.*` — `update.available`, `update.installing`, `update.completed`, `update.failed`

---

## Error Codes

All errors return JSON with both a human `error` string and a stable `code`.
**Match on the `code`, not the message.**

| HTTP | code | Meaning · Action |
|---|---|---|
| 400 | `BAD_REQUEST` | Malformed JSON / Zod validation failed (see `details`) |
| 401 | `UNAUTHENTICATED` | No / invalid JWT — re-login |
| 401 | `INVALID_API_KEY` | API key wrong or revoked — re-issue |
| 401 | `TOTP_REQUIRED` | Login requires 2FA code (browser only) |
| 403 | `FORBIDDEN` | Authenticated but lacks privilege (e.g. non-admin) |
| 403 | `INSUFFICIENT_SCOPE` | Read-only key used for write — use admin key |
| 403 | `BROWSER_ONLY` | API-key callers can't manage API keys |
| 403 | `PASSWORD_CHANGE_REQUIRED` | First-login admin must set their own pw via browser |
| 404 | `NOT_FOUND` | Resource doesn't exist (or isn't yours) |
| 409 | `CONFLICT` | Hostname taken / duplicate / etc. |
| 409 | `LIMIT_REACHED` | Hit a per-user limit (e.g. 20 API keys) |
| 429 | `RATE_LIMITED` | Slow down — check `Retry-After` header |
| 500 | `INTERNAL` | CloudGate broke. Check `/api/health/deep` + container logs. |

---

## Safe Defaults for AI Agents

When an AI agent is operating CloudGate autonomously, follow these rules
so a misjudgement doesn't break a homelab:

1. **Read before write.** Before deleting or updating, GET the resource and
   inspect `last_deployed_at` / `last_error`. Avoid destroying mid-deploy.
2. **Audit before action.** If you're about to revoke / delete / disable
   something, GET `/api/audit?entity_type=...&entity_id=...&limit=10` first.
   Someone may have been working on it.
3. **Health-gate destructive ops.** Always check `/api/health/deep` first.
   If `db.ok == false` or `secrets.ok == false`, refuse to write — escalate
   to a human.
4. **Idempotency.** Most endpoints are idempotent on the same input. If a
   create returns 409 `CONFLICT` with the same hostname, the host already
   exists — fetch it via `GET /api/hosts` instead of retrying.
5. **Confirm before irreversible.** Backups are great but not free. Before
   `DELETE /api/cloudflare/accounts/:id` (cascades to tunnels + hosts),
   either dump a backup or ask a human to confirm.
6. **Don't bash the rate limit.** Use SSE (`/api/events`) for "wait until X"
   instead of busy-looping `GET`s.
7. **Log the action.** Anything you do is in the audit log under your user.
   That's good — but adding `meta: { ai_initiated: true, reason: "..." }`
   when running write ops makes life much easier for the human reviewing
   the log a week later.
8. **Use read-only scope when you can.** A monitoring agent doesn't need
   `admin` — issue a separate `read` key for it.

---

## Reference — Full curl Cookbook

```bash
# Set once per shell session
export CLOUDGATE_KEY="cgk_..."
export CLOUDGATE_URL="https://your-cloudgate"
alias cg='curl -fsSL -H "Authorization: Bearer $CLOUDGATE_KEY" -H "Content-Type: application/json"'

cg "$CLOUDGATE_URL/api/health"                      # health
cg "$CLOUDGATE_URL/api/health/deep"                 # deep health
cg "$CLOUDGATE_URL/api/hosts"                       # list hosts
cg "$CLOUDGATE_URL/api/tunnels"                     # list tunnels
cg "$CLOUDGATE_URL/api/cloudflare/accounts"         # list CF accounts
cg "$CLOUDGATE_URL/api/audit?limit=10"              # last 10 audit events
cg "$CLOUDGATE_URL/api/updates"                     # updater status

# Write operations need admin scope
cg -X POST "$CLOUDGATE_URL/api/tunnels/$ID/restart"
cg -X DELETE "$CLOUDGATE_URL/api/hosts/$ID"
cg -X POST -d '{"hostname":"x.example.com","forward_host":"...","forward_port":...}' \
  "$CLOUDGATE_URL/api/hosts"
```

---

## Versioning & Backwards Compatibility

- New fields may appear in any response — agents should tolerate unknown
  keys.
- A field will not be removed inside a minor version (`v0.x.y` → `v0.x.z`).
- Breaking changes only happen across minor bumps (`v0.x` → `v0.y`) and are
  documented in CHANGELOG.md under `## Breaking Changes`.
- The OpenAPI spec is served live at `/api/openapi.json`. Compare your
  expected version with `info.version` if you care.

If you need a longer-term contract, pin the CloudGate Docker image to an
exact tag (`ghcr.io/elias02345/cloudgate:v0.1.5`).
