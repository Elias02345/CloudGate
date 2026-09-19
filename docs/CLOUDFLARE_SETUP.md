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

## OAuth flow — not implemented

Earlier versions of this document described a `cloudflared login` style
"OAuth"-ish flow as an alternative. **It does not exist in CloudGate.** The
only way to add an account is the API token flow above: the create-account
endpoint accepts a token and nothing else, and zone sync rejects the `oauth`
credential type outright (`CF_UNSUPPORTED_AUTH`).

The API token flow is the supported path, and the recommended one regardless —
it is the only one that can list zones across the account.
