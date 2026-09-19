#!/usr/bin/env bash
# =============================================================================
# Per-store app-store publisher, run once per matrix entry by
# .github/workflows/publish-stores.yml.
#
# Renders (by the caller, via scripts/stores/render.mjs) then:
#   1. shallow-clones the upstream store repo's default branch
#   2. creates/updates our branch cloudgate-v<VERSION> from upstream HEAD
#   3. copies exactly our package files into the upstream app dir
#   4. runs that store's own validator
#   5. diffs — "already-current" if nothing changed
#   6. dry-run: writes diff + would-be PR to the job summary
#      live:    pushes to our fork and opens/updates a PR
#
# Always writes store-status-<STORE>.json, even on failure (via the EXIT
# trap below), so the summary job has something to read regardless of how
# this script exits.
#
# Required env: STORE (umbrel|zimaos) TAG VERSION DIGEST MODE (live|dry-run)
# Optional env: GH_TOKEN (STORE_PUBLISH_TOKEN — required only for MODE=live)
# =============================================================================
set -Eeuo pipefail

STORE="${STORE:?STORE is required}"
TAG="${TAG:?TAG is required}"
VERSION="${VERSION:?VERSION is required}"
DIGEST="${DIGEST:?DIGEST is required}"
MODE="${MODE:?MODE is required}"
GH_TOKEN="${GH_TOKEN:-}"

REPO_ROOT="$(pwd)"
STATUS_FILE="${REPO_ROOT}/store-status-${STORE}.json"
BRANCH="cloudgate-v${VERSION}"

# Mask the token everywhere before it's ever used, in case this step's log
# level ends up higher than intended.
[ -n "$GH_TOKEN" ] && echo "::add-mask::${GH_TOKEN}"

case "$STORE" in
  umbrel)
    UPSTREAM_REPO="getumbrel/umbrel-apps"
    UPSTREAM_BRANCH="master"
    APP_DIR="cloudgate"
    SRC_DIR="packaging/umbrel/cloudgate"
    FILES=(umbrel-app.yml docker-compose.yml)
    ;;
  zimaos)
    UPSTREAM_REPO="IceWhaleTech/CasaOS-AppStore"
    UPSTREAM_BRANCH="main"
    APP_DIR="Apps/CloudGate"
    SRC_DIR="packaging/zimaos/CloudGate"
    FILES=(docker-compose.yml icon.svg)
    ;;
  *)
    echo "::error::unknown store '$STORE' (expected umbrel or zimaos)" >&2
    exit 1
    ;;
esac

STATUS_WRITTEN=0
write_status() {
  # write_status <status> <detail> [pr_url]
  local status="$1" detail="$2" pr_url="${3:-}"
  jq -n \
    --arg store "$STORE" --arg status "$status" --arg detail "$detail" \
    --arg pr_url "$pr_url" --arg version "$VERSION" \
    '{store:$store, status:$status, detail:$detail, pr_url:$pr_url, version:$version}' \
    > "$STATUS_FILE"
  echo "[$STORE] status=$status detail=$detail"
  STATUS_WRITTEN=1
}

on_exit() {
  local code=$?
  if [ "$STATUS_WRITTEN" -eq 0 ]; then
    write_status "failed" "Script exited with code $code before completing. See job logs for this store." || true
  fi
}
trap on_exit EXIT

WORKDIR="$(mktemp -d)"
git clone --quiet --depth 1 --branch "$UPSTREAM_BRANCH" \
  "https://github.com/${UPSTREAM_REPO}.git" "$WORKDIR/upstream"
cd "$WORKDIR/upstream"
git checkout --quiet -b "$BRANCH"

mkdir -p "$APP_DIR"
for f in "${FILES[@]}"; do
  cp "${REPO_ROOT}/${SRC_DIR}/${f}" "${APP_DIR}/${f}"
done

echo "--- running upstream validator ($STORE) ---"
case "$STORE" in
  umbrel)
    npm ci --silent
    npm run lint:apps -- cloudgate --check-images
    ;;
  zimaos)
    pip install --quiet --disable-pip-version-check PyYAML
    python3 .github/actions/validate-compose/scripts/validate_compose.py \
      --app-path CloudGate --report-json out/validation-report.json
    ;;
esac

if git diff --quiet -- "$APP_DIR"; then
  write_status "already-current" "packaging/${STORE} already matches ${UPSTREAM_REPO}@${UPSTREAM_BRANCH} for v${VERSION}; nothing to publish."
  exit 0
fi

PR_TITLE="CloudGate v${VERSION}"
PR_BODY="$(cat <<EOF
Updates the CloudGate package to v${VERSION}.

- Image: \`ghcr.io/elias02345/cloudgate:${TAG}@${DIGEST}\`
- Release: https://github.com/Elias02345/CloudGate/releases/tag/${TAG}
- Changelog: https://github.com/Elias02345/CloudGate/blob/main/CHANGELOG.md

Opened automatically by CloudGate's store-publisher workflow.
EOF
)"
DIFF_OUT="$(git diff -- "$APP_DIR" | head -c 20000)"

if [ "$MODE" != "live" ]; then
  {
    echo "### ${STORE} — dry run"
    echo
    echo "**Would-be PR title:** ${PR_TITLE}"
    echo
    echo "**Would-be PR body:**"
    echo '```'
    echo "$PR_BODY"
    echo '```'
    echo
    echo "**Diff against ${UPSTREAM_REPO}@${UPSTREAM_BRANCH}:**"
    echo '```diff'
    echo "$DIFF_OUT"
    echo '```'
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  write_status "dry-run" "Rendered v${VERSION} and diffed against ${UPSTREAM_REPO}@${UPSTREAM_BRANCH}; no push performed."
  exit 0
fi

# --- live: fork, push, open/update PR ---------------------------------------

if [ -z "$GH_TOKEN" ]; then
  write_status "manual-action-required" "STORE_PUBLISH_MODE is live but the STORE_PUBLISH_TOKEN secret is not set."
  exit 0
fi
export GH_TOKEN

OWNER="$(gh api user --jq .login)"
UPSTREAM_NAME="${UPSTREAM_REPO#*/}"
FORK="${OWNER}/${UPSTREAM_NAME}"

if ! gh repo view "$FORK" >/dev/null 2>&1; then
  gh repo fork "$UPSTREAM_REPO" --clone=false >/dev/null
  # Forking is async on GitHub's side; wait for it to actually appear.
  for _ in $(seq 1 15); do
    gh repo view "$FORK" >/dev/null 2>&1 && break
    sleep 4
  done
fi

git config user.name "cloudgate-store-publisher"
git config user.email "actions@users.noreply.github.com"
git add "$APP_DIR"
git commit --quiet -m "$PR_TITLE"

FORK_URL="https://x-access-token:${GH_TOKEN}@github.com/${FORK}.git"

# Look for an existing OPEN PR opened from our fork whose head branch starts
# with "cloudgate" (covers both a prior release's branch and a still-open
# initial listing PR under a plain "cloudgate" branch name).
EXISTING="$(gh pr list --repo "$UPSTREAM_REPO" --state open \
  --json number,headRefName,url,headRepositoryOwner --jq \
  "[.[] | select(.headRepositoryOwner.login == \"${OWNER}\" and (.headRefName | startswith(\"cloudgate\")))] | .[0] // empty")"

if [ -n "$EXISTING" ]; then
  PR_NUMBER="$(jq -r '.number' <<<"$EXISTING")"
  PR_HEAD="$(jq -r '.headRefName' <<<"$EXISTING")"
  PR_URL="$(jq -r '.url' <<<"$EXISTING")"

  # force-with-lease against the branch's actual current remote state, not
  # our local (possibly nonexistent) tracking ref for it.
  git fetch --quiet "$FORK_URL" "$PR_HEAD:refs/remotes/fork/${PR_HEAD}" 2>/dev/null || true
  EXPECTED_SHA="$(git rev-parse -q --verify "refs/remotes/fork/${PR_HEAD}" || echo "0000000000000000000000000000000000000000")"
  { set +x; git push --force-with-lease="${PR_HEAD}:${EXPECTED_SHA}" "$FORK_URL" "HEAD:${PR_HEAD}"; } 2>&1 | sed "s#${GH_TOKEN}#***#g"

  gh pr comment "$PR_NUMBER" --repo "$UPSTREAM_REPO" --body "Updated to v${VERSION}."
  write_status "pr-updated" "Pushed v${VERSION} onto existing PR #${PR_NUMBER} (${PR_HEAD})." "$PR_URL"
else
  { set +x; git push --force-with-lease "$FORK_URL" "HEAD:${BRANCH}"; } 2>&1 | sed "s#${GH_TOKEN}#***#g"

  gh pr create --repo "$UPSTREAM_REPO" --base "$UPSTREAM_BRANCH" \
    --head "${OWNER}:${BRANCH}" --title "$PR_TITLE" --body "$PR_BODY" >/dev/null
  PR_URL="$(gh pr view --repo "$UPSTREAM_REPO" "${OWNER}:${BRANCH}" --json url --jq .url)"
  write_status "pr-opened" "Opened a new PR for v${VERSION}." "$PR_URL"
fi
