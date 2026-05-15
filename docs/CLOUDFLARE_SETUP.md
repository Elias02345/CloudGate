# Cloudflare Setup

CloudGate manages Cloudflare Tunnels and DNS records on your behalf. To do this it needs a **Cloudflare API token** with specific scopes.

## Step 1 — Create an API token

1. Sign in at <https://dash.cloudflare.com/>.
2. Open **My Profile → API Tokens** (top-right avatar → My Profile → API Tokens).
3. Click **Create Token**.
4. Pick **Custom Token** (Create Custom Token → Get started).

## Step 2 — Required permissions

Set the following permission rows:

| Permission | Resource | Access |
|---|---|---|
| **Account → Cloudflare Tunnel** | Include → All accounts (or specific account) | **Edit** |
| **Zone → DNS** | Include → All zones from an account (or specific zones) | **Edit** |
| **Zone → Zone** | Include → All zones | **Read** |

**Account Resources:** Include → your account.
**Zone Resources:** Include → All zones from an account (or hand-pick zones you want to manage).
**Client IP Address Filtering / TTL:** leave defaults.

## Step 3 — Generate & save

1. Click **Continue to summary**, review the scopes, then **Create Token**.
2. **Copy the token immediately** — Cloudflare shows it only once.
3. In CloudGate, navigate to **Cloudflare → Add Account**, paste the token, give it a friendly label, save.
4. CloudGate validates the token against `GET /user/tokens/verify` and lists your zones.

## Why these scopes?

- **Tunnel Edit** — needed to create/delete `cfd_tunnel` resources.
- **DNS Edit** — needed to add the CNAME records that route hostnames to your tunnel.
- **Zone Read** — needed to list and pick your zones in the UI.

CloudGate **never** asks for broader scopes (e.g. account-wide settings, billing). If you see a request to add other scopes, file a security issue (see `SECURITY.md`).

## OAuth flow (alternative, limited)

CloudGate also supports the `cloudflared login` style "OAuth"-ish flow, which gives you a `cert.pem` scoped to specific zones. It's simpler (no token-creation in dashboard) but **does not** allow listing zones across the account — you'll only see the zone you explicitly authorize.

**Recommended for first-time users: the API Token flow above.** OAuth is convenience for power users who already understand cloudflared's auth model.
