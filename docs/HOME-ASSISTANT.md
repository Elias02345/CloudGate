# Home Assistant behind CloudGate: fixing "400: Bad Request"

If Home Assistant returns a bare **400: Bad Request** as soon as it's reachable through CloudGate — LAN access still works fine — this doc is for you.

## Kurzfassung (Deutsch)

Home Assistant lehnt Anfragen mit `400: Bad Request` ab, sobald ein `X-Forwarded-For`-Header ankommt, den HA nicht erwartet. Cloudflare Tunnel fügt diesen Header bei **jeder** Anfrage hinzu, und `cloudflared` kann ihn nicht entfernen — deshalb tritt der Fehler bei jedem CloudGate-Tunnel-Setup zuverlässig auf. LAN-Zugriff funktioniert, weil dort kein Proxy-Header mitgeschickt wird; Push-Benachrichtigungen funktionieren, weil sie über HA Cloud/Firebase laufen und nie durch den Tunnel gehen.

**Die Lösung** ist auf HA-Seite: in `configuration.yaml`

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 172.18.0.0/24
```

eintragen (Adresse = das Docker-Subnetz, aus dem CloudGate HA erreicht — **kein einzelnes IP anpinnen**, sonst bricht es beim nächsten Container-Neustart wieder). CloudGate erkennt dieses Problem automatisch und zeigt die passende Adresse auf der Host-Detailseite an. Danach HA neu starten. Läuft der Host im `local_nginx`-Modus, gibt es alternativ die Option `forwarded_headers: strip`, die aber HAs Brute-Force-Schutz pro Client außer Kraft setzt — die `trusted_proxies`-Lösung ist vorzuziehen.

---

## Root cause

Home Assistant runs a `forwarded_middleware` on every incoming request (see HA source: `homeassistant/components/http/forwarded.py`). If the request carries an `X-Forwarded-For` header, HA performs two checks, and raises a bare `HTTPBadRequest` (400) if either one fails:

1. **`use_x_forwarded_for` is not `true`.** This is HA's *default* — it ships with proxy support off. HA logs:
   > A request from a reverse proxy was received from `<ip>`, but your HTTP integration is not set-up for reverse proxies
   and returns 400.
2. **`use_x_forwarded_for: true`, but the directly-connected TCP peer is not inside `trusted_proxies`.** HA logs:
   > Received X-Forwarded-For header from an untrusted proxy `<ip>`
   and returns 400.

## Why this always happens with CloudGate

Cloudflare's edge adds `X-Forwarded-For` (equal to `CF-Connecting-IP` when the client sent none) and `X-Forwarded-Proto` to **every** proxied request — this is documented Cloudflare behaviour, not something CloudGate does. `cloudflared` passes those headers to the origin unchanged; it has **no configuration option** to strip or rewrite them.

So every request that arrives through the tunnel carries `X-Forwarded-For`, and an unconfigured Home Assistant answers 400 to all of them — every time, for every user, until HA is told to trust the proxy.

## Why it looks so confusing

- **LAN still works.** On the local network there's no proxy in the path, so no `X-Forwarded-For` header is ever sent, and HA never hits the check.
- **Push notifications still arrive.** They leave HA outbound via HA Cloud / Firebase and never traverse the tunnel at all — so "notifications work" tells you nothing about the reverse-proxy problem.
- **The companion app fails the same way the browser does** — both hit the same tunnel URL and get the same 400.
- **Other self-hosted services keep working** through the same tunnel, because they simply ignore `X-Forwarded-For` — only HA validates it this strictly.

## The fix (Home Assistant side)

This is the correct fix for tunnel mode. Add to `configuration.yaml`, then restart HA:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 172.18.0.0/24
```

The address must be the IP range **CloudGate's container** uses to reach Home Assistant.

**Use a `/24` (or your Docker bridge subnet), never a single pinned IP.** Docker assigns the CloudGate container a new IP whenever it's re-created (update, restart, compose recreate), which silently re-breaks `trusted_proxies` and brings the 400 right back — this is the single most common follow-up failure of this fix.

CloudGate detects this misconfiguration automatically and prints the exact address to use on the host's detail page (host status / last error), so you don't have to guess the subnet yourself.

### Editing `configuration.yaml` on Home Assistant OS

On Home Assistant OS, `configuration.yaml` lives in `/config/` and is normally edited via the **File editor** or **Studio Code Server** add-on. After editing:

1. **Developer Tools → YAML → Check configuration.**
2. Restart Home Assistant.

## Common mistakes

- Putting the `http:` block in `docker-compose.yml` instead of `configuration.yaml` — it belongs in HA's own config, not the container environment.
- Wrong YAML indentation — `use_x_forwarded_for` and `trusted_proxies` must be indented **under** `http:`, not at the top level.
- Pinning a single container IP (e.g. `172.18.0.5/32`) that later changes when Docker re-creates the container.
- Using `127.0.0.1` — wrong unless HA and CloudGate share a network namespace. Normally CloudGate connects from a Docker bridge address, not localhost.
- Confusing this with HA's **IP ban** feature, which returns **403**, not 400. If you're seeing 403, it's a different problem — check `ip_bans.yaml` in HA's config directory.

## After the 400 is fixed

- **WebSockets** (`/api/websocket`) work through Cloudflare Tunnel without any extra configuration — no separate fix needed once the 400 above is resolved.
- **Companion app still can't connect?** Check whether **Cloudflare Access / Zero Trust** is enabled on that hostname. The HA companion app cannot render Cloudflare's interstitial login page (see [home-assistant/android#3494](https://github.com/home-assistant/android/issues/3494)), so the app fails there even though a browser succeeds. Fix: exempt the hostname — or at minimum the webhook endpoints — from the Access policy.

## `local_nginx` mode only

When a host runs in CloudGate's `local_nginx` mode, CloudGate itself is the last hop before Home Assistant, so it can control the forwarded headers directly. The host's advanced options expose a `forwarded_headers` setting:

| Value | Behaviour |
|---|---|
| `standard` (default) | Appends CloudGate's own hop to `X-Forwarded-For`, preserving the real client IP. |
| `client_ip_only` | Sends exactly one `X-Forwarded-For` entry: the peer that connected to CloudGate. That's the real client when the browser reaches CloudGate directly, or `cloudflared` when the request came through a tunnel. Use it for origins that choke on multi-hop chains. |
| `strip` | Sends no `X-Forwarded-*` headers at all — HA works with no HA-side configuration. |

**Trade-off with `strip`:** with no forwarded headers, HA sees every visitor as CloudGate's own IP. HA's per-client brute-force banning and rate limiting stop being able to distinguish clients — one attacker triggering a ban gets **every** user banned along with them. Prefer the `trusted_proxies` fix above over `strip` for that reason.

**`forwarded_headers` has no effect in `cloudflare_tunnel` mode.** In that mode `cloudflared`, not CloudGate, is the process handing the request to HA, and `cloudflared` has no option to alter these headers — CloudGate can't do anything about what Cloudflare's edge already attached.

## How to verify

After restarting Home Assistant with the `trusted_proxies` fix in place, reload the CloudGate host page (or re-deploy the host). The forwarded-header probe should stop reporting the rejection, and the host status should no longer flag the misconfiguration.
