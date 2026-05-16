# TODO for Elias — manual steps & testing checklist

> Living document — Claude updates this as work progresses. Anything here is a
> step **only you can do** (needs your hands on a real network, your GitHub
> credentials, your Cloudflare account, etc.). Code changes are committed to
> `dev` by Claude directly.

**Last updated:** 2026-05-16

---

## 🚦 Status overview

| Area | What's done | What's left for you |
|---|---|---|
| Repo + CI | All green on `dev` | — |
| Backend | M1.1–1.4 (auth, CF, tunnels, hosts, SSE) | — |
| Frontend | M1.1–1.4 (login, password, CF, tunnels, hosts) | — |
| Docker image | Builds + smoke-tests on every push | First test on real machine when Starlink is up |
| Auto-install script | _(see below — Claude is building it)_ | Try it once internet is up |
| GHCR image (`:latest`, `:nightly`) | _(Claude will trigger first build)_ | Verify it works |
| GPG release signing | Workflow ready, secret missing | Optional: create GPG key + add as secret |
| Branch protection on `main` | — | One-time GitHub settings click |

---

## ⏳ Once Starlink is up: testing checklist

These are the steps to verify CloudGate end-to-end on real hardware.

### 1. Spin up an Ubuntu LXC container on Proxmox

Helpful presets:
- **Distribution:** Ubuntu 24.04 LTS (Noble)
- **Cores:** 2
- **RAM:** 1024 MB (enough for SQLite + cloudflared + nginx + frontend)
- **Disk:** 4 GB minimum, 8 GB recommended
- **Nesting:** **ON** (required because we run Docker inside the LXC)
- **Keyctl:** ON
- **Unprivileged:** Yes is fine
- **Network:** DHCP, attach to your bridge that has Starlink-side internet

### 2. Run the one-liner installer

After Claude finishes `install/lxc-install.sh` (see status above):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Elias02345/CloudGate/main/install/lxc-install.sh)"
```

The script will:
- Install Docker if missing
- Pull the latest CloudGate image
- Create the data volume + container
- Show the initial admin password
- Print the URL to open in a browser

**If something goes wrong**, the script self-recovers — see `install/lxc-install.sh` for details. If it ever wedges, run it again — it's idempotent.

### 3. Create a Cloudflare API token

See [`docs/CLOUDFLARE_SETUP.md`](docs/CLOUDFLARE_SETUP.md). Quick version:
1. dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom Token
2. Scopes needed:
   - **Account → Cloudflare Tunnel → Edit**
   - **Zone → DNS → Edit**
   - **Zone → Zone → Read**
3. Copy the token immediately (Cloudflare only shows it once)

### 4. Full happy-path test

1. `http://<lxc-ip>/` in browser
2. Login as `admin@cloudgate.local` with the password from container logs
3. Force-change password (12+ chars)
4. **Cloudflare** sidebar → Add account → paste token → see your zones
5. **Tunnels** → Create tunnel → name `homelab` → verify CF dashboard shows it
6. **Hosts** → Add host:
   - Mode: `via Cloudflare Tunnel`
   - Tunnel: the one you just made
   - Zone: a domain you own
   - Hostname: `test.<your-domain>.tld`
   - Forward: `192.168.1.x:8080` (any local web service you have)
7. Wait ~30 seconds → open `https://test.<your-domain>.tld` in browser → see your local service
8. **Verify persistence:**
   - `docker restart cloudgate` → re-login, all data still there
   - `docker rm -f cloudgate` + `docker run ...` reusing the volume → same admin login still works

### 5. Report any failures

If anything is broken, send me:
- `docker logs cloudgate --tail 200`
- The exact step that failed
- Browser dev-tools network tab if it's a UI issue

---

## 🛡️ Optional: GPG signing for releases

The auto-updater verifies GPG signatures before installing. For the **first release** this is optional (releases without signatures still install with a console warning), but recommended.

```bash
# On your dev machine (NOT in the LXC container):
gpg --full-generate-key
# Choose: ECC (sign only), Curve 25519, key never expires (or set 5+ years)
# Name: CloudGate Releases
# Email: your release-signing email (can be a dedicated alias)

# Export the secret key (will be added as GitHub Actions secret)
gpg --armor --export-secret-keys "CloudGate Releases" > cloudgate-release.key
# Copy contents to clipboard, then on GitHub:
#   Repo Settings → Secrets and variables → Actions → New repository secret
#   Name: GPG_PRIVATE_KEY
#   Value: paste

# Also add GPG_PASSPHRASE secret if you set a passphrase.

# Export the public key — commit this to the repo
gpg --armor --export "CloudGate Releases" > docker/keys/release.pub
# Find the fingerprint
gpg --fingerprint "CloudGate Releases"
# Add the fingerprint to SECURITY.md

# SECURELY back up the private key OFFLINE (encrypted USB stick or similar).
# If you lose the secret key, you can't sign new releases — users get warnings.
```

Then commit `docker/keys/release.pub` and update `SECURITY.md` with the fingerprint.

---

## 🔒 Optional: Branch protection on `main`

To prevent accidental direct pushes to `main`:
1. GitHub → repo → Settings → Branches → Add rule
2. Branch name pattern: `main`
3. Check:
   - [x] Require pull request before merging
   - [x] Require status checks (`lint-typecheck-test`, `docker-build`)
   - [x] Require linear history
   - [x] Do not allow bypassing
4. Save

Don't enable on `dev` — we push there frequently.

---

## 📌 Tunnel-managed first time: things to know

- **Initial admin password** is printed in container logs **once**:
  `docker logs cloudgate | grep -A1 "INITIAL ADMIN PASSWORD"`
  Also stored in `/data/secrets/initial-admin.txt` until first login.
- **Update channel** default is `stable`, mode `notify` — meaning when a new release ships, you see a banner in the UI but must click "install". You can switch to `auto` later in Settings → Updates.
- **All data lives in `/data`** — backup that volume and you can move to a new machine seamlessly.

---

## 🚧 Coming next (Claude will build, then this list updates)

- [x] **M0 / M1 Core MVP** — Done
- [ ] **One-liner Ubuntu LXC installer** — In progress
- [ ] **M2 UI polish** — Settings page (lang + theme), dashboard live counts, error boundary, loading skeletons
- [ ] **M4 Production** — 2FA, backup/restore, audit log UI
- [ ] **M5 Auto-Update** — Self-updater service + UI + signed release pipeline
- [ ] **M3 Hybrid mode** — Optional local nginx instead of Cloudflare per host
- [ ] **vNext** — TCP/UDP tunnels (Minecraft etc.), Webhooks, Helm

---

## 📞 Things to tell me when you're back online

1. Did the install script work cleanly? Any errors?
2. Can you login? Does force-password-change work?
3. Does the CF token validate? Do you see your zones?
4. Tunnel-create — does it show up in CF dashboard?
5. Host-add → live within 30s? If not, paste container logs.

I'll update this file as work proceeds. The "What's left for you" column shrinks over time.
