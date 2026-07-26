#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ $# -lt 1 ]; then
  echo "usage: $0 <target-root> [platform] [arch]" >&2
  exit 1
fi

exec node "${SCRIPT_DIR}/prune_packaged_tree.mjs" "$@"
