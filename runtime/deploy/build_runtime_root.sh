#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${RUNTIME_ROOT}/.." && pwd)"
OUTPUT_ROOT="${1:-${REPO_ROOT}/out/runtime-root}"

require_cmd() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    echo "required command not found: ${name}" >&2
    exit 1
  fi
}

runtime_version() {
  require_cmd node
  node -p "const pkg = require(process.argv[1]); if (!pkg.version) throw new Error('missing version'); pkg.version" \
    "${RUNTIME_ROOT}/api-server/package.json"
}

stage_node_package() {
  local package_dir="$1"
  local output_name="$2"

  if [ ! -f "${package_dir}/package.json" ]; then
    return
  fi

  require_cmd npm
  mkdir -p "${OUTPUT_ROOT}/${output_name}"
  cp "${package_dir}/package.json" "${OUTPUT_ROOT}/${output_name}/package.json"
  cp "${package_dir}/package-lock.json" "${OUTPUT_ROOT}/${output_name}/package-lock.json"
  cp "${package_dir}/tsconfig.json" "${OUTPUT_ROOT}/${output_name}/tsconfig.json"
  cp "${package_dir}/tsup.config.ts" "${OUTPUT_ROOT}/${output_name}/tsup.config.ts"
  cp -R "${package_dir}/src" "${OUTPUT_ROOT}/${output_name}/src"
  (
    cd "${OUTPUT_ROOT}/${output_name}"
    npm ci
    npm run build
    npm prune --omit=dev
    rm -rf src
    rm -f tsconfig.json tsup.config.ts
  )
}

stage_source_package() {
  local package_dir="$1"
  local output_name="$2"

  if [ ! -f "${package_dir}/package.json" ]; then
    return
  fi

  mkdir -p "${OUTPUT_ROOT}/${output_name}"
  cp "${package_dir}/package.json" "${OUTPUT_ROOT}/${output_name}/package.json"
  if [ -d "${package_dir}/src" ]; then
    cp -R "${package_dir}/src" "${OUTPUT_ROOT}/${output_name}/src"
  fi
}

RUNTIME_VERSION="$(runtime_version)"
if [ -z "${RUNTIME_VERSION}" ]; then
  echo "failed to resolve runtime version from runtime/api-server/package.json" >&2
  exit 1
fi

GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || printf 'unknown')"
BUILD_ID="${HOLABOSS_RUNTIME_BUILD_ID:-local}"
SCHEMA_VERSION="${HOLABOSS_RUNTIME_SCHEMA_VERSION:-1}"
BUILD_TIMESTAMP_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

rm -rf "${OUTPUT_ROOT}"

stage_source_package "${RUNTIME_ROOT}/harnesses" "harnesses"
stage_node_package "${RUNTIME_ROOT}/harness-host" "harness-host"
stage_node_package "${RUNTIME_ROOT}/state-store" "state-store"
stage_node_package "${RUNTIME_ROOT}/api-server" "api-server"
cp -R "${SCRIPT_DIR}/bootstrap" "${OUTPUT_ROOT}/bootstrap"
chmod +x "${OUTPUT_ROOT}/bootstrap/"*.sh

cat > "${OUTPUT_ROOT}/metadata.json" <<EOF
{
  "runtime_version": "${RUNTIME_VERSION}",
  "runtime_schema_version": "${SCHEMA_VERSION}",
  "git_sha": "${GIT_SHA}",
  "build_id": "${BUILD_ID}",
  "built_at_utc": "${BUILD_TIMESTAMP_UTC}",
  "source_path": "runtime"
}
EOF

echo "assembled runtime root at ${OUTPUT_ROOT}" >&2
