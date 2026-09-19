# App-store packaging

Source files for listing CloudGate on self-hosting app stores. Not built or
shipped by CloudGate itself — these are submitted to each store's own repo.

## Layout

- `assets/` — `icon.svg`, the app icon: the Tabler `cloud-computing` glyph
  (MIT) the web UI shows in its header, in a brand-orange gradient on a dark
  tile. `icon-512.png` / `icon-256.png` are rendered from it with
  `rsvg-convert -w <size> -h <size> icon.svg -o icon-<size>.png` (librsvg,
  e.g. in a `debian:bookworm-slim` container). ZimaOS carries its own copy
  in `zimaos/CloudGate/icon.svg`. Screenshots: see "Screenshots" below.
- `umbrel/cloudgate/` — [Umbrel App Store](https://github.com/getumbrel/umbrel-apps)
  package (`umbrel-app.yml` + `docker-compose.yml`), following that repo's
  `umbrel-package-app` skill.
- `zimaos/CloudGate/` — [ZimaOS/CasaOS App Store](https://github.com/IceWhaleTech/CasaOS-AppStore)
  package (`docker-compose.yml` with a top-level `x-casaos` block, v2
  protocol), per that repo's `docs/specs/compose-and-x-casaos.md`.
- `truenas/cloudgate/` — [TrueNAS Apps](https://github.com/truenas/apps)
  community-train package (`app.yaml`, `ix_values.yaml`, `questions.yaml`,
  `README.md`, `templates/docker-compose.yaml` Jinja2 template,
  `templates/test_values/basic-values.yaml`). Deliberately does **not**
  include `templates/library/` (the vendored rendering library) — see
  "TrueNAS library vendoring" below.
- `unraid/` — Unraid Community Applications template
  (`ca_profile.xml` + `templates/cloudgate.xml`). Source of truth for files
  that must eventually live in a **separate, dedicated** GitHub repo — see
  "Unraid: dedicated repo, not a subfolder" below.

## How each package is validated

Validated by cloning the relevant upstream repo into a scratch directory,
copying the package in, and running that store's own tooling. Nothing
upstream is vendored into this repo; the clones are throwaway.

| Store | Validator | What it checks |
|---|---|---|
| Umbrel | `node .tools/lint-apps.mjs cloudgate --check-images` (from a clone of `getumbrel/umbrel-apps`) | Manifest shape, port uniqueness, image pinning + multi-arch pull, `app_proxy` wiring, persistence paths |
| ZimaOS | `.github/actions/validate-compose/scripts/validate_compose.py` (from a clone of `IceWhaleTech/CasaOS-AppStore`) | YAML validity, top-level `name` format, `x-casaos.id` reverse-domain format, `docker compose config -q` (needs Docker) |
| TrueNAS | YAML parses; port checked against `.github/scripts/port_validation.py`; library API calls cross-checked against `library/2.3.13/*.py` source (from a clone of `truenas/apps`) | Full `ci.py --wait=true` run passed — see "TrueNAS: how it was validated" below |
| Unraid | `xml.dom.minidom.parse()` (Python stdlib) | Well-formed XML only — no official schema validator is published |

`.github/workflows/packaging.yml` runs the parts of this that don't need a
clone of an upstream repo (see that file for exactly what).

## What `scripts/stores/render.mjs` rewrites — and what it doesn't

`node scripts/stores/render.mjs <X.Y.Z> <sha256:digest>` rewrites, in place:

- `packaging/umbrel/cloudgate/umbrel-app.yml` — `version`, `releaseNotes`
- `packaging/umbrel/cloudgate/docker-compose.yml` — image tag + digest
- `packaging/zimaos/CloudGate/docker-compose.yml` — image tag + digest,
  `x-casaos.version`, `update_at`, `release_notes`

It deliberately leaves alone:

- **`packaging/truenas/**`** — TrueNAS's own Renovate bot bumps
  `ix_values.yaml` image tags automatically after a PR merges into
  `truenas/apps` (see that repo's `CONTRIBUTIONS.md`, "If the versioning of
  an image is not SemVer, a custom versioning regex must be added in the
  renovate-config.js file"). The package's own `app.yaml.version` is a
  *packaging* version (starts at `1.0.0`, bumped by hand only when the
  package definition itself changes, per their contribution guide) — it is
  not tied to CloudGate's release version, so this script has no business
  touching it either.
- **`packaging/unraid/**`** — `Repository` is pinned to `:latest` by design
  (the Unraid/Community Applications convention; CA's own tooling pulls
  fresh on every install/update), so there is no tag or digest field to
  rewrite.

Release notes are pulled from CHANGELOG.md's matching `## [X.Y.Z]` section:
up to the first 5 top-level bullet lines, with a leading
`⚠ Breaking changes:` line prepended if that section has a
`### ... Breaking ...` subsection.

The rewrite is line-based text editing, not a YAML library — none is a
dependency anywhere in this workspace (checked `pnpm-lock.yaml`), so this
avoids adding one just to touch four fields. It's covered by
`scripts/stores/render.test.mjs` (`pnpm run stores:test`), including a
determinism check: rendering twice in a row must produce byte-identical
files.

## Screenshots

`assets/screenshots/` holds four 1568×884 shots (the ZimaOS store format) of the real web UI
(dashboard, hosts, tunnels, Cloudflare accounts). They were taken with
headless Edge against a local Vite dev server whose API was a mock serving
demo data (example.com hostnames, private IPs). The UI is real; only the
data is demo data.

Where each store wants them:

- **Umbrel**: in the PR body only (`umbrel-app.yml` keeps `gallery: []`).
  The Umbrel team creates and hosts the final gallery images.
- **ZimaOS**: committed next to the compose file as
  `zimaos/CloudGate/screenshot-1.png` … `screenshot-4.png`, plus
  `thumbnail.png` (store banner, 1568×884, same layout as the store's other
  apps) and `icon.png`. The store build picks these files up by name.
  `assets/thumbnail.svg` is the thumbnail source; render it from `assets/`
  with `rsvg-convert -w 1568 -h 884 thumbnail.svg -o thumbnail.png` (needs
  the Inter font).
- **TrueNAS**: linked in the PR description. The reviewer uploads them to the
  TrueNAS CDN and fills `app.yaml`'s `screenshots:` and `icon:` with the
  final URLs.
- **Unraid**: optional `<Screenshot>` tags pointing at the raw GitHub URLs of
  `assets/screenshots/*.png`.

## Unraid: dedicated repo, not a subfolder

Community Applications requires a **separate, dedicated repository** for
templates. Two independent sources confirm this:

1. `unraid-community-apps-starter`'s own README: "Use this repository as a
   GitHub template when you want a clean starting point for a **new**
   Community Applications submission repository."
2. The CA "Docker FAQ for template creators/maintainers" forum thread:
   "Create a GitHub repository and upload the XML(s). Use a separate
   repository for your xml files. (Keep it separate from the docker
   associated files if you've built your own container.)"

So `packaging/unraid/` here is the source of truth to copy into that future
dedicated repo (e.g. `Elias02345/unraid-templates`), not something CA reads
directly from `Elias02345/CloudGate`. `templates/cloudgate.xml`'s
`<TemplateURL>` points at that eventual repo path as a placeholder; CA
rewrites `TemplateURL` to the correct value on registration regardless of
what's committed, per the same FAQ thread.

## TrueNAS library vendoring

`templates/library/` (a copy of `truenas/apps`'s `library/2.3.13/`) is
generated by `devbox run copy-lib`, which runs a Docker container
(`ghcr.io/truenas/apps_validation`) against the target repo. It must be
committed for the app to actually render on TrueNAS, but only inside the
**fork of `truenas/apps`** used to open the PR — never in this repo, which
has nothing to do with TrueNAS's rendering pipeline. Run `devbox run
copy-lib` from that fork's root after copying `packaging/truenas/cloudgate/`
into `ix-dev/community/cloudgate/` there.

## TrueNAS: how it was validated

Run in a clone of `truenas/apps` with Docker (WSL):

```bash
cp -r <CloudGate>/packaging/truenas/cloudgate ix-dev/community/
python3 .github/scripts/ci.py --train community --app cloudgate --test-file basic-values.yaml --wait=true
```

`ci.py` vendors the library (`apps_catalog_hash_generate`), renders the
compose file and starts it. Result on 2026-09-19, with `ix_values.yaml`
temporarily pointed at a local build of `dev` (the published v0.3.13 image
predates port 8080): "Containers started successfully", healthy on 8080.

That run caught two bugs a static review missed: `TZ` must not be added by
the template (the library adds it), and the library drops **all** Linux
capabilities by default. CloudGate starts as root, so the template sets
`set_user(0, 0)` and adds exactly the capabilities it needs (see the comment
in `templates/docker-compose.yaml`). They were found by starting the image
with `--cap-drop ALL` plus candidate sets.

`port_validation.py` confirmed the default WebUI port `30492` is free. The
vendored `templates/library/` is generated in the fork, not stored here.
