# Contributing to CloudGate

Thanks for your interest! CloudGate is pre-alpha — issues and PRs are very welcome, especially for the M1 milestone.

## Required reading (before your first PR)

1. [`/CLAUDE.md`](../CLAUDE.md) — the persistence contract. Updates that destroy user data are unacceptable; this file explains the rules.
2. [`docs/UPDATE_RULES.md`](UPDATE_RULES.md) — long-form rules with examples.
3. [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — high-level system design.

## Dev setup

```bash
# Clone
git clone https://github.com/Elias02345/CloudGate.git
cd CloudGate

# Install
pnpm install

# Run all services in watch mode (backend + frontend + recovery-ui)
pnpm dev

# Or just one
pnpm --filter @cloudgate/backend dev
pnpm --filter @cloudgate/frontend dev

# Build Docker image and run with docker-compose
pnpm docker:dev
```

**Required tools:** Node 22+, pnpm 9+, Docker.

## Branch strategy

- `main` — release-only. Tag pushes (`v*.*.*`) trigger releases.
- `dev` — active development. All feature work goes here.
- `feature/<short-name>` — short-lived branches off `dev`, PR back into `dev`.

## Tests

```bash
pnpm test                  # all packages
pnpm --filter @cloudgate/backend test
```

The following test suites **must stay green** (CLAUDE.md §6):

- `packages/backend/tests/bootstrap.test.ts`
- `packages/backend/tests/persistence.test.ts`
- `packages/backend/tests/updater.test.ts` (lands in M5)

## Commit & PR style

- Conventional commits welcome but not required.
- Keep PRs focused — one concern per PR.
- Fill out the PR template in full (especially the persistence checklist).

## License

By contributing you agree your work is released under the project's MIT license.
