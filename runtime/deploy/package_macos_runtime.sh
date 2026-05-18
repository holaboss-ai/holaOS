#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${RUNTIME_ROOT}/.." && pwd)"
OUTPUT_ROOT="${1:-${REPO_ROOT}/out/runtime-macos}"
STAGING_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/holaboss-runtime-macos.XXXXXX")"

cleanup() {
  rm -rf "${STAGING_ROOT}"
}
trap cleanup EXIT

require_cmd() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    echo "required command not found: ${name}" >&2
    exit 1
  fi
}

resolve_output_root() {
  local target="$1"
  local parent
  local name

  parent="$(dirname "${target}")"
  name="$(basename "${target}")"
  mkdir -p "${parent}"
  (
    cd "${parent}"
    printf '%s/%s\n' "$(pwd)" "${name}"
  )
}

require_cmd git
OUTPUT_ROOT="$(resolve_output_root "${OUTPUT_ROOT}")"

# ─── Incremental cache gate ─────────────────────────────────────────────
# Compute a content hash over everything that influences the bundle and
# compare against .cache-key inside the existing OUTPUT_ROOT. On hit, skip
# the whole rebuild — the output is already current. Bypass with
# HOLABOSS_RUNTIME_FORCE_REBUILD=1.
compute_cache_key() {
  local files=()
  while IFS= read -r f; do
    files+=("$f")
  done < <(
    {
      find "${RUNTIME_ROOT}/api-server/src" \
           "${RUNTIME_ROOT}/state-store/src" \
           "${RUNTIME_ROOT}/harness-host/src" \
           "${RUNTIME_ROOT}/harnesses/src" \
           -type f 2>/dev/null
      ls "${RUNTIME_ROOT}/api-server/package.json" \
         "${RUNTIME_ROOT}/state-store/package.json" \
         "${RUNTIME_ROOT}/harness-host/package.json" \
         "${RUNTIME_ROOT}/harnesses/package.json" \
         "${RUNTIME_ROOT}/api-server/tsconfig.json" \
         "${RUNTIME_ROOT}/state-store/tsconfig.json" \
         "${RUNTIME_ROOT}/harness-host/tsconfig.json" \
         "${RUNTIME_ROOT}/api-server/tsup.config.ts" \
         "${RUNTIME_ROOT}/state-store/tsup.config.ts" \
         "${RUNTIME_ROOT}/harness-host/tsup.config.ts" \
         "${SCRIPT_DIR}/build_runtime_root.mjs" \
         "${SCRIPT_DIR}/package_macos_runtime.sh" \
         "${SCRIPT_DIR}/stage_python_runtime.mjs" \
         "${SCRIPT_DIR}/prune_packaged_tree.sh" \
         "${REPO_ROOT}/bun.lock" \
         2>/dev/null
    } | sort -u
  )
  if [ "${#files[@]}" -eq 0 ]; then
    printf 'no-inputs\n'
    return
  fi
  printf '%s\0' "${files[@]}" | xargs -0 shasum -a 256 | sort | shasum -a 256 | awk '{print $1}'
}

CACHE_KEY="$(compute_cache_key)"
CACHE_KEY_PATH="${OUTPUT_ROOT}/.cache-key"

if [ "${HOLABOSS_RUNTIME_FORCE_REBUILD:-0}" != "1" ] \
   && [ -f "${CACHE_KEY_PATH}" ] \
   && [ "$(cat "${CACHE_KEY_PATH}" 2>/dev/null || true)" = "${CACHE_KEY}" ]; then
  echo "[package_macos_runtime] cache hit (${CACHE_KEY:0:12}…) → reusing ${OUTPUT_ROOT}"
  exit 0
fi
echo "[package_macos_runtime] cache miss → rebuilding into ${OUTPUT_ROOT}"

NODE_RUNTIME_DIR="${OUTPUT_ROOT}/node-runtime"
PYTHON_RUNTIME_DIR="${OUTPUT_ROOT}/python-runtime"
BIN_DIR="${OUTPUT_ROOT}/bin"
PACKAGE_METADATA_PATH="${OUTPUT_ROOT}/package-metadata.json"
SKIP_NODE_DEPS="${HOLABOSS_SKIP_NODE_DEPS:-0}"
BUILD_NODE_RUNTIME_DIR="${STAGING_ROOT}/build-node-runtime"
BUILD_NODE_BIN="${BUILD_NODE_RUNTIME_DIR}/node_modules/node/bin/node"
LOCAL_NODE_BIN="${NODE_RUNTIME_DIR}/node_modules/node/bin/node"
LOCAL_NPM_BIN="${NODE_RUNTIME_DIR}/node_modules/.bin/npm"
LOCAL_PYTHON_BIN="${PYTHON_RUNTIME_DIR}/bin/python"

DEFAULT_RUNTIME_NODE_VERSION="24.14.1"
NODE_VERSION="${HOLABOSS_RUNTIME_NODE_VERSION:-${DEFAULT_RUNTIME_NODE_VERSION}}"

NPM_VERSION="${HOLABOSS_RUNTIME_NPM_VERSION:-}"
if [ -z "${NPM_VERSION}" ]; then
  require_cmd npm
  NPM_VERSION="$(npm --version)"
fi

PYTHON_VERSION="${HOLABOSS_RUNTIME_PYTHON_VERSION:-3.12.13}"
PYTHON_ARCH_RAW="${HOLABOSS_RUNTIME_PYTHON_ARCH:-$(uname -m)}"
case "${PYTHON_ARCH_RAW}" in
  x64|amd64|x86_64)
    PYTHON_TARGET="x86_64-apple-darwin"
    ;;
  arm64|aarch64)
    PYTHON_TARGET="aarch64-apple-darwin"
    ;;
  *)
    echo "unsupported Python runtime architecture: ${PYTHON_ARCH_RAW}" >&2
    exit 1
    ;;
esac

TOOLCHAIN_ID_RAW="macos-node${NODE_VERSION}-npm${NPM_VERSION}-python${PYTHON_VERSION}-${PYTHON_TARGET}"
TOOLCHAIN_ID="$(printf '%s' "${TOOLCHAIN_ID_RAW}" | tr -c '[:alnum:]._-' '_')"

if [ "${SKIP_NODE_DEPS}" != "1" ]; then
  require_cmd bun
  mkdir -p "${BUILD_NODE_RUNTIME_DIR}"
  # Bootstrap the bundled Node/npm binaries via bun — vastly faster than
  # `npm install` because bun's resolver + extractor is parallel.
  (
    cd "${BUILD_NODE_RUNTIME_DIR}"
    # bun add needs a package.json to write into; create a minimal one.
    if [ ! -f package.json ]; then
      printf '{"name":"holaboss-runtime-node-bundle","private":true}\n' > package.json
    fi
    bun add "node@${NODE_VERSION}" "npm@${NPM_VERSION}"
  )
fi

# Build directly into the final ${OUTPUT_ROOT}/runtime. We used to build into
# ${STAGING_ROOT}/runtime-root and then `cp -R` to OUTPUT_ROOT, but bun's
# `file:../state-store` workspace deps end up as symlinks with absolute paths
# pointing back at STAGING_ROOT. The EXIT trap then deletes STAGING_ROOT and
# every symlink in OUTPUT_ROOT becomes dangling → runtime fails to import
# @holaboss/runtime-state-store with ERR_MODULE_NOT_FOUND.
rm -rf "${OUTPUT_ROOT}"
mkdir -p "${OUTPUT_ROOT}"
mkdir -p "${BIN_DIR}"

if [ "${SKIP_NODE_DEPS}" != "1" ]; then
  PATH="${BUILD_NODE_RUNTIME_DIR}/node_modules/node/bin:${BUILD_NODE_RUNTIME_DIR}/node_modules/.bin:${PATH}" \
    "${BUILD_NODE_BIN}" "${SCRIPT_DIR}/build_runtime_root.mjs" "${OUTPUT_ROOT}/runtime"
else
  require_cmd node
  node "${SCRIPT_DIR}/build_runtime_root.mjs" "${OUTPUT_ROOT}/runtime"
fi

"${SCRIPT_DIR}/prune_packaged_tree.sh" "${OUTPUT_ROOT}/runtime" "macos"

if [ "${SKIP_NODE_DEPS}" != "1" ]; then
  cp -R "${BUILD_NODE_RUNTIME_DIR}" "${NODE_RUNTIME_DIR}"
  "${SCRIPT_DIR}/prune_packaged_tree.sh" "${NODE_RUNTIME_DIR}" "macos"
fi

require_cmd node
node "${SCRIPT_DIR}/stage_python_runtime.mjs" "${OUTPUT_ROOT}" "macos"

cat > "${BIN_DIR}/sandbox-runtime" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TOOLCHAIN_ROOT="${HOLABOSS_RUNTIME_TOOLCHAIN_ROOT:-${BUNDLE_ROOT}}"
BUNDLED_NODE_BIN="${TOOLCHAIN_ROOT}/node-runtime/node_modules/node/bin/node"

export HOLABOSS_RUNTIME_APP_ROOT="${BUNDLE_ROOT}/runtime"
export HOLABOSS_RUNTIME_ROOT="${BUNDLE_ROOT}/runtime"
export HOLABOSS_RUNTIME_TOOLCHAIN_ROOT="${TOOLCHAIN_ROOT}"
export PATH="${TOOLCHAIN_ROOT}/python-runtime/bin:${TOOLCHAIN_ROOT}/python-runtime/python/bin:${TOOLCHAIN_ROOT}/node-runtime/node_modules/node/bin:${TOOLCHAIN_ROOT}/node-runtime/node_modules/.bin:${PATH}"
if [ -x "${BUNDLED_NODE_BIN}" ]; then
  export HOLABOSS_RUNTIME_NODE_BIN="${BUNDLED_NODE_BIN}"
fi

exec "${BUNDLE_ROOT}/runtime/bootstrap/macos.sh" "$@"
EOF

chmod +x "${BIN_DIR}/sandbox-runtime"

cat > "${PACKAGE_METADATA_PATH}" <<EOF
{
  "platform": "macos",
  "toolchain_id": "${TOOLCHAIN_ID}",
  "node_deps_installed": $([ "${SKIP_NODE_DEPS}" = "1" ] && printf 'false' || printf 'true'),
  "bundled_node_bin": $([ "${SKIP_NODE_DEPS}" = "1" ] || [ ! -x "${LOCAL_NODE_BIN}" ] && printf 'false' || printf 'true'),
  "bundled_node_version": $([ "${SKIP_NODE_DEPS}" = "1" ] && printf 'null' || printf '"%s"' "${NODE_VERSION}"),
  "bundled_npm_bin": $([ "${SKIP_NODE_DEPS}" = "1" ] || [ ! -x "${LOCAL_NPM_BIN}" ] && printf 'false' || printf 'true'),
  "bundled_npm_version": $([ "${SKIP_NODE_DEPS}" = "1" ] && printf 'null' || printf '"%s"' "${NPM_VERSION}"),
  "bundled_python_bin": $([ ! -x "${LOCAL_PYTHON_BIN}" ] && printf 'false' || printf 'true'),
  "bundled_python_version": "${PYTHON_VERSION}",
  "bundled_python_target": "${PYTHON_TARGET}"
}
EOF

# Persist the cache key — read at the top of the next run to short-circuit
# this whole pipeline when inputs haven't changed.
printf '%s\n' "${CACHE_KEY}" > "${CACHE_KEY_PATH}"

echo "packaged macOS runtime bundle at ${OUTPUT_ROOT}" >&2
