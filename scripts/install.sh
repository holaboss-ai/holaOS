#!/usr/bin/env bash

set -euo pipefail

REPO_URL="https://github.com/holaboss-ai/holaOS.git"
DEFAULT_INSTALL_DIR="${HOLABOSS_INSTALL_DIR:-$HOME/holaboss-ai}"
HOLABOSS_HOME="${HOLABOSS_HOME:-$HOME/.holaboss}"
MANAGED_NODE_DIR="${HOLABOSS_HOME}/node"
LOCAL_BIN_DIR="${HOME}/.local/bin"
MANAGED_NODE_VERSION="24.14.1"

INSTALL_DIR="${DEFAULT_INSTALL_DIR}"
REF="${HOLABOSS_INSTALL_REF:-main}"
LAUNCH=0

BLUE='\033[0;34m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

usage() {
  cat <<EOF
Holaboss OSS installer

Usage:
  install.sh [OPTIONS]

Options:
  --launch          Run 'npm run desktop:dev' after setup completes
  --ref NAME        Git branch or tag to clone or update (default: main)
  --branch NAME     Alias for --ref
  --dir PATH        Install directory (default: ~/holaboss-ai)
  -h, --help        Show this help
EOF
}

log_info() {
  printf "${CYAN}==>${NC} %s\n" "$1"
}

log_success() {
  printf "${GREEN}✓${NC} %s\n" "$1"
}

log_warn() {
  printf "${YELLOW}!${NC} %s\n" "$1"
}

log_error() {
  printf "${RED}x${NC} %s\n" "$1" >&2
}

fail() {
  log_error "$1"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --launch|--run-dev)
      LAUNCH=1
      shift
      ;;
    --ref|--branch)
      [[ $# -ge 2 ]] || fail "$1 requires a value"
      REF="$2"
      shift 2
      ;;
    --dir)
      [[ $# -ge 2 ]] || fail "--dir requires a value"
      INSTALL_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

detect_os() {
  case "$(uname -s)" in
    Darwin)
      OS="macos"
      ;;
    Linux)
      OS="linux"
      ;;
    *)
      fail "Unsupported operating system: $(uname -s)"
      ;;
  esac
  log_success "Detected ${OS}"
}

shell_config_file() {
  case "$(basename "${SHELL:-/bin/bash}")" in
    zsh)
      printf '%s\n' "${HOME}/.zshrc"
      ;;
    bash)
      printf '%s\n' "${HOME}/.bashrc"
      ;;
    *)
      printf '%s\n' "${HOME}/.profile"
      ;;
  esac
}

ensure_shell_line() {
  local line="$1"
  local target_file

  target_file="$(shell_config_file)"
  touch "${target_file}"

  if ! grep -Fq "${line}" "${target_file}"; then
    {
      printf '\n'
      printf '# Holaboss installer\n'
      printf '%s\n' "${line}"
    } >> "${target_file}"
    log_success "Updated ${target_file}"
  fi
}

ensure_local_bin_on_path() {
  mkdir -p "${LOCAL_BIN_DIR}"
  case ":${PATH}:" in
    *":${LOCAL_BIN_DIR}:"*) ;;
    *)
      export PATH="${LOCAL_BIN_DIR}:${PATH}"
      ;;
  esac

  ensure_shell_line 'export PATH="$HOME/.local/bin:$PATH"'
}

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi

  fail "Need root or sudo to install system packages"
}

activate_brew() {
  local brew_bin=""

  if command -v brew >/dev/null 2>&1; then
    brew_bin="$(command -v brew)"
  elif [[ -x /opt/homebrew/bin/brew ]]; then
    brew_bin="/opt/homebrew/bin/brew"
  elif [[ -x /usr/local/bin/brew ]]; then
    brew_bin="/usr/local/bin/brew"
  fi

  if [[ -z "${brew_bin}" ]]; then
    return 1
  fi

  eval "$("${brew_bin}" shellenv)"
  BREW_BIN="${brew_bin}"
  return 0
}

ensure_brew_on_path() {
  local brew_shellenv_line

  brew_shellenv_line="eval \"\$(${BREW_BIN} shellenv)\""
  ensure_shell_line "${brew_shellenv_line}"

  if ! command -v brew >/dev/null 2>&1; then
    eval "$("${BREW_BIN}" shellenv)"
  fi
}

install_homebrew() {
  log_info "Installing Homebrew so git can be installed"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  activate_brew || fail "Homebrew installed but could not be activated"
}

install_git_linux() {
  log_info "Installing git"
  if command -v apt-get >/dev/null 2>&1; then
    run_privileged apt-get update
    run_privileged apt-get install -y git
  elif command -v dnf >/dev/null 2>&1; then
    run_privileged dnf install -y git
  elif command -v yum >/dev/null 2>&1; then
    run_privileged yum install -y git
  elif command -v pacman >/dev/null 2>&1; then
    run_privileged pacman -Sy --noconfirm git
  elif command -v zypper >/dev/null 2>&1; then
    run_privileged zypper --non-interactive install git
  elif command -v apk >/dev/null 2>&1; then
    run_privileged apk add --no-cache git
  else
    fail "Unsupported Linux package manager. Install git manually and rerun."
  fi
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    log_success "Git found ($(git --version))"
    return
  fi

  case "${OS}" in
    macos)
      activate_brew || install_homebrew
      ensure_brew_on_path
      log_info "Installing git via Homebrew"
      "${BREW_BIN}" install git
      ;;
    linux)
      install_git_linux
      ;;
  esac

  command -v git >/dev/null 2>&1 || fail "git installation completed but git is still unavailable"
  log_success "Git ready ($(git --version))"
}

require_cmd() {
  local name="$1"
  command -v "${name}" >/dev/null 2>&1 || fail "Required command not found: ${name}"
}

install_managed_node() {
  require_cmd curl
  require_cmd tar

  local node_os
  local node_arch
  local shasums_url
  local tarball_name=""
  local archive_url
  local tmp_dir
  local extracted_dir

  case "${OS}" in
    macos) node_os="darwin" ;;
    linux) node_os="linux" ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) node_arch="x64" ;;
    arm64|aarch64) node_arch="arm64" ;;
    *) fail "Unsupported architecture for managed Node.js install: $(uname -m)" ;;
  esac

  shasums_url="https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/SHASUMS256.txt"
  log_info "Installing managed Node.js ${MANAGED_NODE_VERSION} and npm"

  tarball_name="$(
    curl -fsSL "${shasums_url}" \
      | grep -E " node-v${MANAGED_NODE_VERSION//./\\.}-${node_os}-${node_arch}\\.tar\\.gz$" \
      | awk '{print $2}' \
      | head -1
  )"

  if [[ -z "${tarball_name}" ]]; then
    tarball_name="$(
      curl -fsSL "${shasums_url}" \
        | grep -E " node-v${MANAGED_NODE_VERSION//./\\.}-${node_os}-${node_arch}\\.tar\\.xz$" \
        | awk '{print $2}' \
        | head -1
    )"
  fi

  [[ -n "${tarball_name}" ]] || fail "Could not resolve a Node.js ${MANAGED_NODE_VERSION} binary for ${node_os}-${node_arch}"

  archive_url="https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/${tarball_name}"
  tmp_dir="$(mktemp -d)"

  curl -fsSL "${archive_url}" -o "${tmp_dir}/${tarball_name}"

  if [[ "${tarball_name}" == *.tar.gz ]]; then
    tar -xzf "${tmp_dir}/${tarball_name}" -C "${tmp_dir}"
  else
    tar -xJf "${tmp_dir}/${tarball_name}" -C "${tmp_dir}"
  fi

  extracted_dir="$(find "${tmp_dir}" -maxdepth 1 -type d -name "node-v${MANAGED_NODE_VERSION}*" | head -1)"
  [[ -n "${extracted_dir}" ]] || fail "Node.js archive extracted but no runtime directory was found"

  mkdir -p "${HOLABOSS_HOME}"
  rm -rf "${MANAGED_NODE_DIR}"
  mv "${extracted_dir}" "${MANAGED_NODE_DIR}"

  ensure_local_bin_on_path
  ln -sf "${MANAGED_NODE_DIR}/bin/node" "${LOCAL_BIN_DIR}/node"
  ln -sf "${MANAGED_NODE_DIR}/bin/npm" "${LOCAL_BIN_DIR}/npm"
  ln -sf "${MANAGED_NODE_DIR}/bin/npx" "${LOCAL_BIN_DIR}/npx"
  ln -sf "${MANAGED_NODE_DIR}/bin/corepack" "${LOCAL_BIN_DIR}/corepack"
  export PATH="${MANAGED_NODE_DIR}/bin:${LOCAL_BIN_DIR}:${PATH}"
  rm -rf "${tmp_dir}"

  log_success "Managed Node.js ready ($(node --version))"
  log_success "Managed npm ready ($(npm --version))"
}

ensure_node_and_npm() {
  local node_version=""
  local node_major=""

  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    node_version="$(node --version 2>/dev/null || true)"
    node_major="$(printf '%s' "${node_version}" | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "${node_major}" =~ ^[0-9]+$ ]] && (( node_major >= 24 )); then
      log_success "Node.js found (${node_version})"
      log_success "npm found ($(npm --version))"
      return
    fi

    log_warn "Node.js 24+ is required. Found ${node_version:-unknown}; installing managed Node.js ${MANAGED_NODE_VERSION}."
  else
    log_info "Node.js 24 and npm are missing; installing managed Node.js ${MANAGED_NODE_VERSION}"
  fi

  install_managed_node
}

prepare_checkout() {
  mkdir -p "$(dirname "${INSTALL_DIR}")"
  INSTALL_DIR="$(cd "$(dirname "${INSTALL_DIR}")" && pwd)/$(basename "${INSTALL_DIR}")"

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log_info "Existing checkout found at ${INSTALL_DIR}; updating"
    (
      cd "${INSTALL_DIR}"
      if [[ -n "$(git status --porcelain)" ]]; then
        fail "Existing checkout has local changes. Commit or stash them before rerunning."
      fi
      git fetch origin
      git checkout "${REF}"
      git pull --ff-only origin "${REF}"
    )
    log_success "Repository updated"
    return
  fi

  if [[ -e "${INSTALL_DIR}" ]]; then
    fail "Install directory exists but is not a git checkout: ${INSTALL_DIR}"
  fi

  log_info "Cloning ${REPO_URL} into ${INSTALL_DIR}"
  git clone --branch "${REF}" "${REPO_URL}" "${INSTALL_DIR}"
  log_success "Repository cloned"
}

bootstrap_repo() {
  cd "${INSTALL_DIR}"

  log_info "Installing desktop dependencies"
  npm run desktop:install

  if [[ ! -f desktop/.env ]]; then
    log_info "Creating desktop/.env from desktop/.env.example"
    cp desktop/.env.example desktop/.env
  else
    log_info "desktop/.env already exists; leaving it unchanged"
  fi

  log_info "Preparing the local runtime bundle"
  npm run desktop:prepare-runtime:local

  log_info "Verifying desktop typecheck"
  npm run desktop:typecheck

  if (( LAUNCH == 1 )); then
    log_info "Starting desktop development runtime"
    exec npm run desktop:dev
  fi

  printf '\n'
  log_success "Holaboss desktop setup is complete"
  printf '%bRun%b %bnpm run desktop:dev%b when you are ready to launch the app.\n' "${BLUE}" "${NC}" "${CYAN}" "${NC}"
}

main() {
  detect_os
  ensure_git
  ensure_node_and_npm
  prepare_checkout
  bootstrap_repo
}

main "$@"
