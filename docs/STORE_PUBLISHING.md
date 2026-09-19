# Store Publishing

How CloudGate reaches homelab app stores, and what happens on each release.
Package sources and validation details: [`packaging/README.md`](../packaging/README.md).
Binding rules: `CLAUDE.md` §10.

## Stores and how they get new versions

| Store | Package | After acceptance, per release |
|---|---|---|
| Unraid (Community Applications) | `packaging/unraid/`, mirrored into a dedicated template repo | Nothing. The template uses `:latest`; Unraid compares image digests. |
| TrueNAS (community train) | `packaging/truenas/cloudgate/` | Nothing. Their Renovate bot opens the version PR. No bot PR after 48 h → open an issue in `truenas/apps`. |
| Umbrel | `packaging/umbrel/cloudgate/` | Automatic PR from `publish-stores.yml`. |
| ZimaOS | `packaging/zimaos/CloudGate/` | Automatic PR from `publish-stores.yml`. |

Not offered yet:

| Store | Blocker |
|---|---|
| Proxmox community scripts | Their rules: no Docker, at least 6 months old, 600+ GitHub stars. Needs a Docker-free install as well. |
| TerraMaster | No root in the container, and images must come from Docker Hub. The store also cannot update Docker apps. |
| Dokploy | Weak fit (VPS audience; the web UI can only be reached through a domain on their Traefik proxy). |

## What every store package has in common

- Container port **8080** only. Ports 80/443 serve local reverse-proxy mode and are left to the user.
- `/data` persisted. That's all CloudGate's state: secrets, database, tunnel credentials, certificates.
- `CLOUDGATE_DISABLE_UPDATES=true`. The platform replaces the image; the in-app updater stays off, and the Updates page says so.
- No privileged mode, no host networking, no Docker socket.

## Release flow

A stable tag `vX.Y.Z` on `main` runs `.github/workflows/release.yml`:

1. **preflight**: the tag is on `main`, every package version matches, then install, build, typecheck, lint, tests, release tarball.
2. **image**: pushes `:vX.Y.Z`, checks the multi-arch index digest and that linux/amd64 and linux/arm64 are both in it.
3. **release**: the GitHub Release (tarball, sha256, optional signature).
4. **promote**: `:latest` and `:main` are pointed at the verified digest.
5. **stores**: calls `publish-stores.yml` with the tag and digest. A store failure does not undo anything above.

`dev`, nightly builds and pull requests never publish: only the tag trigger reaches `release.yml`, and preflight rejects tags that are not on `main`.

## `publish-stores.yml`

For Umbrel and ZimaOS (in parallel; one failing does not stop the other), `scripts/stores/publish.sh`:

1. Clones the store repo's default branch. If our fork has an open PR whose branch name contains `cloudgate` (e.g. the first listing PR `add-cloudgate`), it continues on that branch; otherwise it creates `cloudgate-vX.Y.Z`.
2. **App already in the store:** takes the store's own copy of the files and rewrites only version, `image: …:vX.Y.Z@sha256:…` and release notes (`scripts/stores/render.mjs`). Whatever the store maintainers added (Umbrel's gallery, the submission link, review fixes) stays. **First submission:** copies our package folder.
3. Runs the store's own validator (Umbrel `lint:apps --check-images`, ZimaOS `validate_compose.py`).
4. No change → `already-current`. Otherwise:
   - **dry-run**: diff and the would-be PR go into the job summary.
   - **live**: push to the fork and open the PR, or add a commit to the open one (never a force-push onto an open PR, never a merge).

Release notes are generated from the version's CHANGELOG section: the first five entries, each shortened to its bold lead-in. A `### Breaking Changes` heading adds a warning line on top.

The summary table lists GHCR, Unraid, TrueNAS, Umbrel and ZimaOS with their status:

| Status | Meaning |
|---|---|
| `pr-opened` / `pr-updated` | Done, with the PR link. |
| `already-current` | The store already has this version. |
| `dry-run` | Nothing pushed (publish mode is not `live`). |
| `manual-action-required` | Live mode, but the token secret is missing. |
| `disabled` | Switched off with `STORE_<NAME>_ENABLED=false`. |
| `failed` | See that store's job log. The summary job turns red. |

## One-time GitHub setup

| Kind | Name | Value |
|---|---|---|
| Secret | `STORE_PUBLISH_TOKEN` | Personal access token of the account that owns the forks. Cross-repository PRs need a **classic** token with the `public_repo` scope; fine-grained tokens can't open PRs against repositories you don't own. |
| Variable | `STORE_PUBLISH_MODE` | `live` to publish. Unset or anything else = dry-run. Leave it unset until Umbrel and ZimaOS have accepted CloudGate. |
| Variable (optional) | `STORE_UMBREL_ENABLED`, `STORE_ZIMAOS_ENABLED` | `false` skips that store. |

The forks (`<owner>/umbrel-apps`, `<owner>/CasaOS-AppStore`) are created automatically in live mode if missing.

## Retrying a store

Actions → **Publish to app stores** → Run workflow → tag `vX.Y.Z`. It resolves the image digest itself, rebuilds nothing, and is safe to repeat: an already-published version reports `already-current`, and an open PR is updated rather than duplicated.

To see what a real run would do, leave `STORE_PUBLISH_MODE` unset and run it: the job summary shows the exact diff per store.

## Adding a store later

1. Add `packaging/<store>/` following that store's current contribution docs, with the four rules above.
2. Extend the checks in `.github/workflows/packaging.yml`.
3. If it needs a PR per release, add it to the matrix in `publish-stores.yml` and a `case` in `publish.sh`. Extend `render.mjs` if its version fields differ.
