#!/usr/bin/env bash

set -euo pipefail

RUN_DEV=0

for arg in "$@"; do
  case "$arg" in
    --run-dev)
      RUN_DEV=1
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [--run-dev]"
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

require_cmd git
require_cmd node
require_cmd npm

NODE_VERSION="$(node -v)"
NODE_MAJOR="$(echo "$NODE_VERSION" | sed -E 's/^v([0-9]+).*/\1/')"
if (( NODE_MAJOR < 24 )); then
  echo "Node.js 24+ is required. Found: $NODE_VERSION"
  exit 1
fi

echo "==> Running desktop dependency install"
npm run desktop:install

if [[ ! -f apps/desktop/.env ]]; then
  echo "==> Creating apps/desktop/.env from apps/desktop/.env.example"
  cp apps/desktop/.env.example apps/desktop/.env
else
  echo "==> apps/desktop/.env already exists; leaving it unchanged"
fi

echo "==> Staging local runtime bundle"
npm run desktop:prepare-runtime:local

echo "==> Verifying desktop typecheck"
npm run desktop:typecheck

if (( RUN_DEV == 1 )); then
  echo "==> Starting desktop dev runtime"
  npm run desktop:dev
else
  echo "Setup complete."
  echo "Run 'npm run desktop:dev' when you are ready to launch the app."
  echo "Or rerun this script with '--run-dev' to launch automatically."
fi
