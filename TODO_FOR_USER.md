# TODO for Elias — manual steps & testing checklist

> Living document — Claude updates this as work progresses. Anything here is a
> step **only you can do** (needs your hands on a real network, your GitHub
> credentials, your Cloudflare account, etc.). Code changes are committed to
> `dev` by Claude directly.

**Last updated:** 2026-05-16 — M1 through M5 done, CI green, image on GHCR

---

## 🚦 Status overview

| Area | What's done | What's left for you |
|---|---|---|
| Repo + CI | All green on `dev` | — |
| Backend M1 Auth + M1 Cloudflare + M1 Tunnels + M1 Hosts | ✅ | — |
| Frontend M1 (Login, CF, Tunnels, Hosts) | ✅ | — |
| M2 UI Polish (Dashboard, Settings, Theme, i18n, ErrorBoundary) | ✅ | — |
| M4 Production (2FA, Backup, Audit log) | ✅ | — |
| M5 Auto-Update (Updater, UpdatesPage, apply-update.sh) | ✅ | — |
| M3 Hybrid Mode Phase 1 (local_nginx, no ACME yet) | ✅ | — |
| Docker image | Builds + smoke-tests on every push | First test on real machine when Starlink is up |
| One-liner LXC installer | ✅ ready in `install/lxc-install.sh` | Try it once internet is up |
| GHCR `:nightly` + `:dev` images | ✅ exist on GHCR | — |
| GHCR `:latest` image | ⬜ — first `v0.x.y` tag on `main` triggers it | One-line action after testing |
| GPG release signing | ⬜ workflow ready, secret missing | Optional: create GPG key + add as secret |
| Branch protection on `main` | ⬜ | One-time GitHub settings click |

**Lines of code so far (`dev` branch):** ~6,800 (backend + frontend + Docker + docs).

---

## ⏳ Once Starlink is up: testing checklist

### Step 1 — Spin up an Ubuntu LXC on Proxmox

Recommended Proxmox settings:
- **Distribution:** Ubuntu 24.04 LTS
- **Cores:** 2 · **RAM:** 1 GB · **Disk:** 4–8 GB
- **Features:** `nesting=1, keyctl=1` (CRITICAL — Docker won't start without nesting)
- **Network:** DHCP, bridge with Starlink-side internet

### Step 2 — Run the one-liner installer

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Elias02345/CloudGate/dev/install/lxc-install.sh)"
```

> Note: I've kept it pointing at `dev` until you tag your first `v0.1.0` on `main`,
> at which point we'll update README to point at the `main` branch.

The script will:
- Check internet connectivity (12×5s retries)
- Install Docker via official apt repo (falls back to distro `docker.io` if needed)
- Try image candidates in order: `:latest` → `:main` → `:nightly` → `:dev` → build from source
- Create a persistent `cloudgate-data` volume
- Start the container with `--restart unless-stopped`
- Wait up to 180s for `/api/health`
- Print initial admin credentials + LAN URL

### Step 3 — Create a Cloudflare API token

See [`docs/CLOUDFLARE_SETUP.md`](docs/CLOUDFLARE_SETUP.md). Quick version:
1. dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom Token
2. Scopes:
   - **Account → Cloudflare Tunnel → Edit**
   - **Zone → DNS → Edit**
   - **Zone → Zone → Read**
3. Copy the token immediately.

### Step 4 — Full happy-path test (~5 min)

1. `http://<lxc-ip>/` → Login as `admin@cloudgate.local` + password from `docker logs cloudgate`
2. Force password change (12+ chars)
3. **Cloudflare** → Add account → paste token → see your zones
4. **Tunnels** → Create tunnel `homelab` → verify CF dashboard shows it
5. **Hosts** → Add host:
   - Mode: `via Cloudflare Tunnel`
   - Tunnel: the one you just made
   - Zone: a domain you own
   - Hostname: `test.<your-domain>.tld`
   - Forward: `192.168.1.x:8080` (any local web service)
6. Wait ~30s → open `https://test.<your-domain>.tld` → should reach your local service

### Step 5 — Verify the Production goodies

7. **Settings → 2FA** → Set up authenticator → scan QR with Aegis/Authy → enter code → enable
8. **Logout → Login again** — should require TOTP code
9. **Settings → Backup** → download an encrypted `.cgbk` file (test passphrase + confirm)
10. **Audit log** sidebar → see all your actions logged
11. **Updates** sidebar → status card, "Check now", channel/mode selectors

### Step 6 — Verify persistence

12. `docker restart cloudgate` → re-login, all data still there
13. `docker rm -f cloudgate` → re-run the installer → existing volume → same admin login still works

### Step 7 — Report back

If anything broke, send me:
- `docker logs cloudgate --tail 300`
- The exact step that failed + your browser dev-tools network tab if it was UI

---

## 🚀 Once first test is happy — release v0.1.0

```bash
# In a working clone:
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

After that, **`:latest` exists on GHCR** and the installer's first image candidate works without falling back.

---

## 🛡️ Optional: GPG signing for releases

Without GPG: the self-updater installs releases but logs a warning ("unsigned").
With GPG: signature is mandatory — much harder for someone to substitute a malicious image.

```bash
# On your dev machine (NOT in the LXC):
gpg --full-generate-key
# Choose: ECC (sign only), Curve 25519, 5 years
# Name: CloudGate Releases  ·  Email: a dedicated alias

# Export private key (for GitHub Actions secret)
gpg --armor --export-secret-keys "CloudGate Releases" > cloudgate-release.key
# Copy contents into:
#   GitHub → repo Settings → Secrets → Actions → New repo secret
#   Name: GPG_PRIVATE_KEY  Value: <paste>
# If your key has a passphrase, also add GPG_PASSPHRASE secret.

# Export public key + commit
gpg --armor --export "CloudGate Releases" > docker/keys/release.pub
gpg --fingerprint "CloudGate Releases"   # → add to SECURITY.md
git add docker/keys/release.pub SECURITY.md && git commit -m "security: add release signing key"

# CRITICAL: back up the private key OFFLINE (encrypted USB).
# Losing it means no more signed releases — users get warnings forever.
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
  to `/data/secrets/initial-admin.txt` inside the container — auto-deleted after
  first login.
- **Update channel** defaults to `stable`, mode `notify`. Change in Settings → Updates.
- **All data lives in `/data`** — backup the Docker volume and you can move/restore.
- **Encrypted backup format** is `.cgbk` (AES-GCM + PBKDF2). Keep the passphrase
  separately from the backup file. Restore wizard ships in M6.
- **Recovery UI** kicks in automatically if the main backend can't start.
  Same port 80, shows logs + status — never a blank page.

---

## 🚧 Coming next

These are next on Claude's list, in priority order:

- [ ] **M3 Hybrid Mode** — Optional local nginx instead of Cloudflare per host
  (lets you reverse-proxy LAN services without going through CF). Needs ACME
  / Let's Encrypt integration.
- [ ] **First `v0.1.0` release** — happens after you test on hardware
- [ ] **Restore wizard** — first-run setup can accept a `.cgbk` backup file
- [ ] **README screenshots** — needs a running instance with real data
- [ ] **TCP/UDP tunnels** — Minecraft / SSH support (vNext)
- [ ] **Multi-user with RBAC** (vNext)
- [ ] **Webhooks** (vNext)

---

## 📞 Things to tell me when you're back online

1. **Install:** Did the one-liner work? Any errors at any stage?
2. **Login:** Auto-generated admin password from logs worked? Force-change worked?
3. **CF:** Token validated? Zones appeared?
4. **Tunnel:** Created? Visible in CF dashboard?
5. **Host:** End-to-end <30s? `curl https://your-host` returned your local service?
6. **2FA:** QR code scanned? Re-login required the code?
7. **Backup:** Download worked? File ~2KB+ size?
8. **Audit log:** Sees the login/2FA/backup events?
9. **Updates page:** Status loads? Settings persist after refresh?

I'll update this file as work proceeds. The "What's left for you" column shrinks over time.
