# TODO for Elias — manual steps & testing checklist

> Living document — Claude updates this as work progresses. Anything here is a
> step **only you can do** (needs your hands on a real network, your GitHub
> credentials, your Cloudflare account, etc.). Code changes are committed to
> `dev` by Claude directly.

**Last updated:** 2026-05-18 — M6 (Guided Onboarding) + M7 (Shell API) merged on `dev`, M8 (AI Assistant) in PR #3

---

## 🚦 Status overview

| Area | What's done | What's left for you |
|---|---|---|
| Repo + CI | All green on `dev` (last commit `1da08fe`) | — |
| Backend Auth + Cloudflare + Tunnels + Hosts | ✅ M1 complete | — |
| Frontend (Login, CF, Tunnels, Hosts, Settings, Audit, Updates) | ✅ M1+M2 complete | — |
| 2FA, Backup, Audit log | ✅ M4 subset | — |
| Self-update (poll + GPG + apply-update.sh + rollback) | ✅ M5 | — |
| Hybrid mode (local nginx) + Let's Encrypt DNS-01 | ✅ M3 | — |
| Onboarding wizard (5-step Stepper, auto-trigger on empty state) | ✅ | — |
| Restore wizard (.cgbk import on fresh container) | ✅ | — |
| Recovery UI extras (DB restore, soft reset, hard reset) | ✅ | — |
| Deep `/api/health/deep` endpoint | ✅ | — |
| Update banner in header | ✅ | — |
| Bulk CSV import for hosts | ✅ | — |
| Donate page (PayPal + BTC + ETH + SOL with QR codes) | ✅ | — |
| First-login account setup (set your own email + name + password) | ✅ | — |
| GitHub Sponsor button (FUNDING.yml + SPONSORING.md) | ✅ | — |
| **M6** Guided Onboarding + react-joyride App-Tour | ✅ merged (PR #1) | Test the smooth wizard + tour after Starlink is up |
| **M7** Shell API (long-lived `cgk_*` keys) + OpenAPI 3.1 + AGENT.md | ✅ merged (PR #2) | Try the curl recipes in `docs/AGENT.md` Recipe A–G |
| **M8** Optional in-app AI assistant (Anthropic + OpenAI + custom) | 🟡 PR #3 (CI running) | Bring your own LLM key, pick autonomy mode (suggest_only recommended) |
| Audit-middleware on all writing routes | ✅ | — |
| Log rotation (pino-roll 7-day, 10MB) | ✅ | — |
| Docker HEALTHCHECK | ✅ | — |
| PUID/PGID support | ✅ | — |
| Strict CSP headers | ✅ | — |
| Mantine brand theme (cg-orange) | ✅ | — |
| Tests (bootstrap, crypto, auth, persistence, tunnel-config-writer, restore, updater-compare) | ✅ | — |
| Docker image | Builds + smoke-tests on every push | First test on real machine when Starlink is up |
| One-liner LXC installer | ✅ ready in `install/lxc-install.sh` | Try it once internet is up |
| GHCR `:nightly` + `:dev` images | ✅ exist on GHCR | — |
| GHCR `:latest` image | ⬜ — first `v0.x.y` tag on `main` triggers it | One-line action after testing |
| GPG release signing | ⬜ workflow ready, secret missing | Optional: create GPG key + add as secret |
| Branch protection on `main` | ⬜ | One-time GitHub settings click |

**Total commits on `dev`:** ~63 · **CI runs:** consistently green for the last batch.

### M6/M7/M8 short summary

**M6 Guided Onboarding** ([PR #1](https://github.com/Elias02345/CloudGate/pull/1) merged):
- 6 steps with inline SVG animations (welcome cloud, key glide, tunnel flow, server check, spinner, confetti)
- Step 5 runs `/api/health/deep` live + shows per-subsystem pass/fail with "fix this" hints
- After Done → react-joyride spotlight tour through all 12 main pages
- Settings → "Help & guided tour" card replays anything at any time
- Persisted in DB as `user.{id}.onboarding_completed_at` / `tour_completed_at` / `tour_dismissed`

**M7 Shell API** ([PR #2](https://github.com/Elias02345/CloudGate/pull/2) merged):
- Long-lived `cgk_<prefix>_<secret>` keys, scoped `admin` | `read`, optional expiry
- `requireAuth` accepts JWT OR API key — SPA unaffected
- Per-key rate limit (60 admin / 120 read per minute)
- CORS conditional: `Authorization: Bearer cgk_*` → `Access-Control-Allow-Origin: *`
- `/api/openapi.json` live spec + `/api-docs` UI
- `docs/AGENT.md` 470-line copy-paste guide for AI agents (Recipes A–G)
- `Settings → API keys` page with create/rotate/revoke + shown-once plaintext modal

**M8 In-App AI Assistant** ([PR #3](https://github.com/Elias02345/CloudGate/pull/3) — CI running):
- Multi-provider: Anthropic (Claude) · OpenAI · Custom Base URL (OpenRouter, LMStudio, Ollama, vLLM)
- 3 autonomy modes — `off` (default) · `suggest_only` (writes need click-confirm) · `autonomous`
- 9 read tools + 4 write tools (create_host, toggle_host, delete_host, restart_tunnel)
- Floating chat drawer with Markdown rendering (remark-gfm) and inline confirmation cards
- API key stored AES-256-GCM-encrypted; never returned to the browser
- New routes: `/api/ai/{settings,chat,conversations,confirm-action}`

---

## ⏳ Once Starlink is up: testing checklist

### Step 1 — Spin up an Ubuntu LXC on Proxmox

- **Distribution:** Ubuntu 24.04 LTS
- **Cores:** 2 · **RAM:** 1 GB · **Disk:** 4–8 GB
- **Features:** `nesting=1, keyctl=1` (CRITICAL — Docker won't start without nesting)
- **Network:** DHCP, bridge with Starlink-side internet

### Step 2 — Run the one-liner installer

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Elias02345/CloudGate/dev/install/lxc-install.sh)"
```

The script will:
- Wait for network (12×5s)
- Install Docker via official apt repo (falls back to distro `docker.io`)
- Try image candidates: `:latest` → `:main` → `:nightly` → `:dev` → build from source
- Create persistent `cloudgate-data` volume
- Start container with `--restart unless-stopped`
- Wait 180s for `/api/health`
- Print initial admin credentials + LAN URL

### Step 3 — Create a Cloudflare API token

See [`docs/CLOUDFLARE_SETUP.md`](docs/CLOUDFLARE_SETUP.md). Quick:
- dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom Token
- **Account → Cloudflare Tunnel → Edit**
- **Zone → DNS → Edit**
- **Zone → Zone → Read**
- Copy the token immediately.

### Step 4 — Full happy-path test (~5 min)

1. `http://<lxc-ip>/` → Login as `admin@cloudgate.local` + password from `docker logs cloudgate`
2. Force password change → automatic redirect to **Onboarding** (5-step Stepper)
3. **Step 2 (Onboarding):** Paste your CF token → see your zones populate
4. **Step 3:** Name your tunnel (e.g. `homelab`) → CF dashboard shows the tunnel
5. **Step 4:** Click "Add host" → form with cascading tunnel→zone dropdowns
6. Enter `test.<your-domain>.tld` → `192.168.1.x:8080` → Create
7. Wait ~30s → `https://test.<your-domain>.tld` reaches your local service

### Step 5 — Production features

8. **Settings → 2FA** → scan QR with Aegis/Authy → enter code → enable
9. **Logout → Login again** — login requires TOTP
10. **Settings → Backup** → download encrypted `.cgbk` file (test passphrase + confirm)
11. **Audit log** → see all your actions logged with timestamps + IP
12. **Updates** → status card, "Check now", channel/mode selectors
13. **Top-right** → orange "Update X available" badge appears when a release ships

### Step 6 — Hybrid mode (optional, local nginx instead of CF tunnel)

14. Add another host: switch **Mode** to `via local nginx`
15. After it's deployed, click the certificate icon (cyan) in the host row
16. Confirm DNS-01 cert acquisition → wait ~30s → host now serves HTTPS

### Step 7 — Verify persistence

17. `docker restart cloudgate` → re-login, all data still there
18. `docker rm -f cloudgate` → re-run installer → existing volume → same admin login works

### Step 8 — Stress-test anti-brick

These should never break things, but worth exercising:

19. Visit `http://<lxc-ip>/__recovery/` while CloudGate is healthy — see recovery UI
20. **Recovery UI** shows: status, logs, DB backups list, soft/hard reset buttons
21. Test **soft reset** (clears bootstrap markers, keeps data) — `docker restart cloudgate` → re-bootstraps cleanly
22. Test **DB restore from backups/** — pick a pre-update snapshot → restart → DB rolled back

### Step 9 — Bulk import (nice-to-have test)

23. **Hosts → Bulk import** → paste a 3-line CSV:
    ```
    hostname,forward_host,forward_port
    a.your-domain.tld,192.168.1.10,8080
    b.your-domain.tld,192.168.1.11,8081
    c.your-domain.tld,192.168.1.12,8082
    ```
24. Pick default tunnel + zone in the modal → Import → see all 3 deploy

### Step 10 — Report back

If anything broke, send me:
- `docker logs cloudgate --tail 300`
- The exact step that failed + browser dev-tools network tab if it was UI

---

## 🚀 Once first test is happy — release v0.1.0

```bash
git checkout main
git merge dev --no-ff
git tag v0.1.0
git push origin main --tags
```

This triggers `.github/workflows/release.yml`:
- Builds release tarball + sha256
- Optionally GPG-signs (if `GPG_PRIVATE_KEY` secret is set)
- Creates GitHub Release with download artifacts
- Builds + pushes multi-arch Docker image `ghcr.io/elias02345/cloudgate:v0.1.0`, `:latest`, `:main`

After that, **`:latest` exists on GHCR** and the installer pulls it directly.

---

## 🛡️ Optional: GPG signing for releases

Without GPG: the self-updater installs releases but logs an unsigned warning.
With GPG: signature is required — much harder for someone to substitute a malicious image.

```bash
# On your dev machine (NOT in the LXC):
gpg --full-generate-key
# Choose: ECC (sign only), Curve 25519, 5 years
# Name: CloudGate Releases  ·  Email: a dedicated alias

# Export private key (for GitHub Actions secret)
gpg --armor --export-secret-keys "CloudGate Releases" > cloudgate-release.key
# Paste into: GitHub → repo Settings → Secrets → Actions → New repo secret
#   Name: GPG_PRIVATE_KEY  Value: <paste>
# Also add GPG_PASSPHRASE secret if your key has a passphrase.

# Export public key + commit
gpg --armor --export "CloudGate Releases" > docker/keys/release.pub
gpg --fingerprint "CloudGate Releases"   # → add to SECURITY.md
git add docker/keys/release.pub SECURITY.md && git commit -m "security: add release signing key"

# CRITICAL: back up the private key OFFLINE (encrypted USB).
```

---

## 🔒 Optional: Branch protection on `main`

GitHub → repo Settings → Branches → Add rule → `main`:
- [x] Require pull request
- [x] Require status checks (`lint-typecheck-test`, `docker-build`)
- [x] Require linear history
- [x] Do not allow bypassing

Don't enable on `dev` — we push there frequently.

---

## 📌 Things to know about the running system

- **Initial admin password** appears in `docker logs cloudgate` once. Also written
  to `/data/secrets/initial-admin.txt` — auto-deleted after first login.
- **Update channel** defaults to `stable`, mode `notify`. Change in Settings → Updates.
- **All data lives in `/data`** — backup the Docker volume and you can move/restore.
- **Encrypted backup format** is `.cgbk` (AES-256-GCM + PBKDF2 200k). Keep the passphrase
  separately from the backup file. Use `/restore` page on a fresh container to restore it.
- **Recovery UI** kicks in automatically on port 80 if main backend can't start.
  Always reachable at `/__recovery/` even when healthy.
- **CSP** is enabled — no inline scripts, strict connect-src, frame-ancestors none.
- **PUID/PGID** env vars are honoured for /data ownership (LinuxServer.io convention).
- **Auto-rollback** of failed updates — `apply-update.sh` snapshots /app + DB before
  swap; on health-check fail it restores both and restarts.

---

## 🚧 Coming after first test

- [ ] **First `v0.1.0` release** — after your green test
- [ ] **README screenshots** — needs a running instance with real data
- [ ] **TCP/UDP tunnels** — Minecraft / SSH support (vNext)
- [ ] **Multi-user with RBAC** (vNext)
- [ ] **Webhooks** for update.* and host.* events (vNext)
- [ ] **Prometheus /metrics endpoint** (vNext)

---

## 📞 Things to tell me when you're back online

1. **Install:** Did the one-liner work? Any errors at any stage?
2. **Login:** Auto-generated admin password from logs worked? Force-change worked?
3. **Onboarding:** Did the 5-step wizard launch automatically? Smooth flow?
4. **CF:** Token validated? Zones appeared?
5. **Tunnel:** Created? Visible in CF dashboard?
6. **Host:** End-to-end <30s? `curl https://your-host` returned your local service?
7. **2FA:** QR code scanned? Re-login required the code?
8. **Backup:** Download worked? File >100B size? Can you re-import on a fresh container at `/restore`?
9. **Audit log:** Sees the login/2FA/backup/host events?
10. **Updates page:** Status loads? Settings persist after refresh? Channel switcher works?
11. **Hybrid mode:** Did a `local_nginx` host work? Did cert issuance succeed?
12. **Bulk import:** Try with a 3-line CSV — works?
13. **Recovery UI:** `http://<host>/__recovery/` shows everything?

I'll update this file when the test results come in.
