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

  require_cmd bun
  mkdir -p "${OUTPUT_ROOT}/${output_name}"
  cp "${package_dir}/package.json" "${OUTPUT_ROOT}/${output_name}/package.json"
  cp "${package_dir}/tsconfig.json" "${OUTPUT_ROOT}/${output_name}/tsconfig.json"
  cp "${package_dir}/tsup.config.ts" "${OUTPUT_ROOT}/${output_name}/tsup.config.ts"
  cp -R "${package_dir}/src" "${OUTPUT_ROOT}/${output_name}/src"
  if [ -d "${package_dir}/scripts" ]; then
    cp -R "${package_dir}/scripts" "${OUTPUT_ROOT}/${output_name}/scripts"
  fi
  (
    cd "${REPO_ROOT}"
    bun install --frozen-lockfile --linker=isolated
    cd "${package_dir}"
    bun run build
    cd "${REPO_ROOT}"
    bun install --production --frozen-lockfile --linker=isolated --ignore-scripts
    cp -R "${package_dir}/dist" "${OUTPUT_ROOT}/${output_name}/dist"
    if [ -d "${package_dir}/node_modules" ]; then
      cp -RL "${package_dir}/node_modules" "${OUTPUT_ROOT}/${output_name}/node_modules"
    fi
    rm -rf "${OUTPUT_ROOT}/${output_name}/src"
    rm -f "${OUTPUT_ROOT}/${output_name}/tsconfig.json" "${OUTPUT_ROOT}/${output_name}/tsup.config.ts"
  )
}

build_node_packages() {
  require_cmd bun
  (
    cd "${REPO_ROOT}"
    bun install --frozen-lockfile --linker=isolated
    for package_dir in "$@"; do
      (
        cd "${package_dir}"
        bun run build
      )
    done
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
build_node_packages "${REPO_ROOT}/packages/remote-api" "${RUNTIME_ROOT}/channel-gateway"
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
