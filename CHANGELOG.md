# Changelog

All notable changes to CloudGate are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial project skeleton (M0): monorepo with `backend`, `frontend`, `recovery-ui`, `shared`.
- Zero-config Docker image with multi-stage build (Node 22 + nginx + cloudflared + s6-overlay).
- Bootstrap service: auto-generates encryption keys, JWT secret, admin password on first run.
- Recovery UI fallback served when the main backend cannot start.
- Initial DB schema (users, settings, cloudflare_accounts, cf_zones, tunnels, proxy_hosts, audit_log, update_history).
- i18n scaffolding with German and English locales.
- GitHub Actions: `ci.yml`, `release.yml`, `nightly.yml`.
- Persistence-contract documentation in `CLAUDE.md` and `docs/UPDATE_RULES.md`.

## [0.0.1] - Pre-alpha

First scaffold. Not functional yet — see roadmap.
