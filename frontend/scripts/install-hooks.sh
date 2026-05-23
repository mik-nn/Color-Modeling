#!/usr/bin/env bash
# Wire .githooks/ to git via core.hooksPath. Idempotent.
# Called from frontend/package.json `postinstall`.

set -euo pipefail

# Locate the repo root from this script's location: frontend/scripts → ../..
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.githooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "install-hooks: $HOOKS_DIR does not exist; skipping."
  exit 0
fi

# Skip if not inside a git work tree (e.g. fresh tarball install).
if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "install-hooks: $REPO_ROOT is not a git work tree; skipping."
  exit 0
fi

# Make hooks executable.
chmod +x "$HOOKS_DIR"/* 2>/dev/null || true

# Point git at the in-repo hooks directory.
git -C "$REPO_ROOT" config core.hooksPath .githooks

echo "install-hooks: core.hooksPath set to .githooks"
