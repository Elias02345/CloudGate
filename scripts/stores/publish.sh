#!/usr/bin/env bash
# =============================================================================
# Per-store app-store publisher, run once per matrix entry by
# .github/workflows/publish-stores.yml.
#
#   1. shallow-clones the upstream store repo's default branch; starts from
#      our open PR branch if one exists, else a new cloudgate-v<VERSION>
#   2. app already in the store: renders the store's own copy of the files
#      (version, image@digest, release notes only); first submission: copies
#      our whole package folder
#   3. runs that store's own validator
#   4. diffs — "already-current" if nothing changed
#   5. dry-run: writes diff + would-be PR to the job summary
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
    ;;
  zimaos)
    UPSTREAM_REPO="IceWhaleTech/CasaOS-AppStore"
    UPSTREAM_BRANCH="main"
    APP_DIR="Apps/CloudGate"
    SRC_DIR="packaging/zimaos/CloudGate"
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

if [ "${ENABLED:-}" = "false" ]; then
  write_status "disabled" "Skipped — STORE_$(echo "$STORE" | tr '[:lower:]' '[:upper:]')_ENABLED is set to false."
  exit 0
fi

UPSTREAM_NAME="${UPSTREAM_REPO#*/}"
OWNER=""
EXISTING=""
if [ -n "$GH_TOKEN" ]; then
  export GH_TOKEN
  OWNER="$(gh api user --jq .login)"
  # An open PR from our fork whose head branch contains "cloudgate" — a
  # previous release still in review (cloudgate-vX.Y.Z), or the first
  # listing PR (add-cloudgate). New versions
  # go on top of it instead of opening a second PR.
  EXISTING="$(gh pr list --repo "$UPSTREAM_REPO" --state open \
    --json number,headRefName,url,headRepositoryOwner --jq \
    "[.[] | select(.headRepositoryOwner.login == \"${OWNER}\" and (.headRefName | test(\"cloudgate\")))] | .[0] // empty")"
fi

WORKDIR="$(mktemp -d)"
git clone --quiet --depth 1 --branch "$UPSTREAM_BRANCH" \
  "https://github.com/${UPSTREAM_REPO}.git" "$WORKDIR/upstream"
cd "$WORKDIR/upstream"
if [ -n "$EXISTING" ]; then
  PR_HEAD="$(jq -r '.headRefName' <<<"$EXISTING")"
  git fetch --quiet "https://github.com/${OWNER}/${UPSTREAM_NAME}.git" "$PR_HEAD"
  git checkout --quiet -B "$PR_HEAD" FETCH_HEAD
else
  git checkout --quiet -b "$BRANCH"
fi

# RENDERED are the files render.mjs edits line by line (version, image@digest,
# release notes). Once the app exists in the store, render *their* copies, so
# whatever the store maintainers added (Umbrel's gallery, the submission URL,
# review fixes) survives; assets are left alone. Only a first submission
# copies our whole package folder.
case "$STORE" in
  umbrel) RENDERED=(umbrel-app.yml docker-compose.yml) ;;
  zimaos) RENDERED=(docker-compose.yml) ;;
esac
if [ -f "${APP_DIR}/${RENDERED[0]}" ]; then
  for f in "${RENDERED[@]}"; do cp "${APP_DIR}/${f}" "${REPO_ROOT}/${SRC_DIR}/${f}"; done
  (cd "$REPO_ROOT" && node scripts/stores/render.mjs "$VERSION" "$DIGEST")
  for f in "${RENDERED[@]}"; do cp "${REPO_ROOT}/${SRC_DIR}/${f}" "${APP_DIR}/${f}"; done
else
  (cd "$REPO_ROOT" && node scripts/stores/render.mjs "$VERSION" "$DIGEST")
  mkdir -p "$APP_DIR"
  cp -r "${REPO_ROOT}/${SRC_DIR}/." "${APP_DIR}/"
fi

echo "--- running upstream validator ($STORE) ---"
case "$STORE" in
  umbrel)
    npm ci --silent
    npm run lint:apps -- cloudgate --check-images
    ;;
  zimaos)
    python3 -c "import yaml" 2>/dev/null || pip install --quiet --disable-pip-version-check PyYAML
    python3 .github/actions/validate-compose/scripts/validate_compose.py \
      --app-path CloudGate --report-json out/validation-report.json
    ;;
esac

# Stage before diffing: plain `git diff` is blind to untracked files, which
# is exactly what every file is on a first-ever submission (no cloudgate/ or
# Apps/CloudGate/ upstream yet) — without staging first that case would
# silently report "already-current" instead of opening the initial PR.
git add -A -- "$APP_DIR"
if git diff --cached --quiet -- "$APP_DIR"; then
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
DIFF_OUT="$(git diff --cached -- "$APP_DIR" | head -c 20000)"

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
# $APP_DIR is already staged (from the diff check above).
git commit --quiet -m "$PR_TITLE"

FORK_URL="https://x-access-token:${GH_TOKEN}@github.com/${FORK}.git"

if [ -n "$EXISTING" ]; then
  PR_NUMBER="$(jq -r '.number' <<<"$EXISTING")"
  PR_URL="$(jq -r '.url' <<<"$EXISTING")"

  # The commit sits on top of the PR branch we checked out above, so this is
  # a fast-forward: no force, and review commits on that branch stay.
  { set +x; git push "$FORK_URL" "HEAD:${PR_HEAD}"; } 2>&1 | sed "s#${GH_TOKEN}#***#g"

  gh pr comment "$PR_NUMBER" --repo "$UPSTREAM_REPO" --body "Updated to v${VERSION}."
  write_status "pr-updated" "Pushed v${VERSION} onto existing PR #${PR_NUMBER} (${PR_HEAD})." "$PR_URL"
else
  { set +x; git push --force-with-lease "$FORK_URL" "HEAD:${BRANCH}"; } 2>&1 | sed "s#${GH_TOKEN}#***#g"

  gh pr create --repo "$UPSTREAM_REPO" --base "$UPSTREAM_BRANCH" \
    --head "${OWNER}:${BRANCH}" --title "$PR_TITLE" --body "$PR_BODY" >/dev/null
  PR_URL="$(gh pr view --repo "$UPSTREAM_REPO" "${OWNER}:${BRANCH}" --json url --jq .url)"
  write_status "pr-opened" "Opened a new PR for v${VERSION}." "$PR_URL"
fi
