#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${RUNTIME_ROOT}/.." && pwd)"
OUTPUT_ROOT="${1:-${REPO_ROOT}/out/runtime-linux}"
STAGING_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/holaboss-runtime-linux.XXXXXX")"

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
    PYTHON_TARGET="x86_64-unknown-linux-gnu"
    ;;
  arm64|aarch64)
    PYTHON_TARGET="aarch64-unknown-linux-gnu"
    ;;
  *)
    echo "unsupported Python runtime architecture: ${PYTHON_ARCH_RAW}" >&2
    exit 1
    ;;
esac

TOOLCHAIN_ID_RAW="linux-node${NODE_VERSION}-npm${NPM_VERSION}-python${PYTHON_VERSION}-${PYTHON_TARGET}"
TOOLCHAIN_ID="$(printf '%s' "${TOOLCHAIN_ID_RAW}" | tr -c '[:alnum:]._-' '_')"

# Build directly into ${OUTPUT_ROOT}/runtime — bun's `file:../state-store`
# workspace deps install as absolute-path symlinks, so staging-then-cp leaves
# them pointing at a temp dir that the EXIT trap then nukes (ERR_MODULE_NOT_FOUND
# at runtime startup). Skipping the staging copy keeps the targets valid.
run_build_runtime_root() {
  local attempt=1
  local max_attempts=3

  while true; do
    rm -rf "${OUTPUT_ROOT}/runtime"
    if [ "${SKIP_NODE_DEPS}" != "1" ]; then
      PATH="${BUILD_NODE_RUNTIME_DIR}/node_modules/node/bin:${BUILD_NODE_RUNTIME_DIR}/node_modules/.bin:${PATH}" \
        "${BUILD_NODE_BIN}" "${SCRIPT_DIR}/build_runtime_root.mjs" "${OUTPUT_ROOT}/runtime" && return 0
    else
      require_cmd node
      node "${SCRIPT_DIR}/build_runtime_root.mjs" "${OUTPUT_ROOT}/runtime" && return 0
    fi

    if [ "${attempt}" -ge "${max_attempts}" ]; then
      return 1
    fi

    echo "runtime root assembly failed on attempt ${attempt}/${max_attempts}; retrying" >&2
    attempt=$((attempt + 1))
    sleep "${attempt}"
  done
}

if [ "${SKIP_NODE_DEPS}" != "1" ]; then
  require_cmd npm
  mkdir -p "${BUILD_NODE_RUNTIME_DIR}"
  npm install --prefix "${BUILD_NODE_RUNTIME_DIR}" "node@${NODE_VERSION}" "npm@${NPM_VERSION}"
fi

rm -rf "${OUTPUT_ROOT}"
mkdir -p "${OUTPUT_ROOT}"
mkdir -p "${BIN_DIR}"

run_build_runtime_root

"${SCRIPT_DIR}/prune_packaged_tree.sh" "${OUTPUT_ROOT}/runtime" "linux"

if [ "${SKIP_NODE_DEPS}" != "1" ]; then
  cp -R "${BUILD_NODE_RUNTIME_DIR}" "${NODE_RUNTIME_DIR}"
  "${SCRIPT_DIR}/prune_packaged_tree.sh" "${NODE_RUNTIME_DIR}" "linux"
fi

require_cmd node
node "${SCRIPT_DIR}/stage_python_runtime.mjs" "${OUTPUT_ROOT}" "linux"

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

exec "${BUNDLE_ROOT}/runtime/bootstrap/linux.sh" "$@"
EOF

chmod +x "${BIN_DIR}/sandbox-runtime"

cat > "${PACKAGE_METADATA_PATH}" <<EOF
{
  "platform": "linux",
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

echo "packaged Linux runtime bundle at ${OUTPUT_ROOT}" >&2
