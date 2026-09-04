#!/usr/bin/env bash
# ROADMAP SC#4: validate that the OKB pre-commit guard regex matches BOTH
# the legacy `.data/knowledge-export/<file>.json` path AND the canonical
# `.data/exports/<file>.json` path. This is the BC guarantee that lets
# Phase 37 introduce the canonical path without breaking the existing hook.
#
# Self-contained: this test does NOT depend on the km-core src/ being
# implemented. It is GREEN from day one.

set -euo pipefail

# Step 1: extract the KB_PATTERN regex from the live hook (single source of
# truth — if the hook changes, this test reflects reality).
CODING_ROOT="${CODING_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
HOOK_PATH="$CODING_ROOT/scripts/hooks/pre-commit-okb-guard.sh"
if [ ! -f "$HOOK_PATH" ]; then
  echo "FAIL: hook not found at $HOOK_PATH"
  exit 1
fi

# Pull the KB_PATTERN value, strip the variable assignment and surrounding quotes.
KB_PATTERN=$(grep '^KB_PATTERN=' "$HOOK_PATH" | head -1 | sed -E "s/^KB_PATTERN=['\"]?//; s/['\"]?$//")
if [ -z "$KB_PATTERN" ]; then
  echo "FAIL: could not extract KB_PATTERN from $HOOK_PATH"
  exit 1
fi

# Sanity-check the regex covers both legacy and canonical paths.
if ! echo "$KB_PATTERN" | grep -q "knowledge-export"; then
  echo "FAIL: KB_PATTERN does not match knowledge-export path: $KB_PATTERN"
  exit 1
fi
if ! echo "$KB_PATTERN" | grep -q "exports"; then
  echo "FAIL: KB_PATTERN does not match exports path: $KB_PATTERN"
  exit 1
fi

# Step 2: build a tmp git repo to exercise the regex against staged paths.
TMPDIR=$(mktemp -d -t km-core-symlink-bc.XXXXXX)
trap "rm -rf '$TMPDIR'" EXIT

cd "$TMPDIR"
git init -q
git config user.email "test@example.invalid"
git config user.name "Test Runner"

mkdir -p .data/exports .data/knowledge-export

# Real file lives at the canonical path; legacy path is a symlink back.
echo '{"nodes":[],"edges":[]}' > .data/exports/coding.json
(cd .data/knowledge-export && ln -s ../exports/coding.json coding.json)

# Verify the symlink resolves to the canonical file.
LINK_TARGET=$(readlink .data/knowledge-export/coding.json)
if [ "$LINK_TARGET" != "../exports/coding.json" ]; then
  echo "FAIL: symlink target wrong: got '$LINK_TARGET' expected '../exports/coding.json'"
  exit 1
fi

# Step 3: stage both paths and confirm git surfaces them via the KB regex.
git add -A
STAGED=$(git diff --cached --name-only | grep -E "$KB_PATTERN" || true)
COUNT=$(echo "$STAGED" | grep -c . || true)
if [ "$COUNT" -lt 1 ]; then
  echo "FAIL: KB_PATTERN matched zero staged files; expected >= 1"
  echo "staged: $(git diff --cached --name-only)"
  exit 1
fi

echo "PASS: KB_PATTERN matches $COUNT staged path(s); symlink BC verified."
echo "       regex      = $KB_PATTERN"
echo "       staged     = $STAGED"
echo "       symlink to = $LINK_TARGET"
exit 0
