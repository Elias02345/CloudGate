<!--
Thanks for contributing to CloudGate! 🌩️
Please read CLAUDE.md and docs/UPDATE_RULES.md before submitting.
-->

## Summary

<!-- 1–2 sentences: what does this PR do and why? -->

## Type of change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Refactor / internal cleanup

## Persistence & Update Safety Checklist

> See [`CLAUDE.md`](../CLAUDE.md) §1–§5.

- [ ] **No sacred path touched.** I have NOT written to or deleted anything under `/data/secrets/`, `/data/db/db.sqlite`, `/data/cloudflared/*.json`, `/data/nginx/custom/`, `/data/nginx/certs/`, or `/data/logs/`.
- [ ] **Migrations are idempotent and reversible.** New columns are nullable or have defaults. `down()` is implemented and works.
- [ ] **No existing migration was edited.** Any schema change is a NEW migration file.
- [ ] **Settings defaults unchanged** (or, if changed, explicitly documented in `CHANGELOG.md` with migration logic).
- [ ] **`update-manifest.json` updated** if my change introduces a required migration or a breaking change.
- [ ] **No required ENV variable introduced.** Every new env var has a safe auto-generated default in `bootstrap.ts`.

## Testing

- [ ] `bootstrap.test.ts` is green (on fresh + existing `/data`).
- [ ] `persistence.test.ts` is green.
- [ ] New tests added for any new logic.
- [ ] Manually tested in `docker compose -f docker/docker-compose.dev.yml up`.

## CHANGELOG

- [ ] User-visible changes documented in `CHANGELOG.md` under `## Unreleased`.

## Related issues

<!-- Link any related issues: closes #123, fixes #456, etc. -->
