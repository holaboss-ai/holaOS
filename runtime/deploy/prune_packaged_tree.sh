#!/usr/bin/env bash
set -euo pipefail

TARGET_ROOT="${1:-}"
TARGET_PLATFORM="${2:-}"

if [ -z "${TARGET_ROOT}" ]; then
  echo "usage: $0 <target-root> [platform]" >&2
  exit 1
fi

if [ ! -e "${TARGET_ROOT}" ]; then
  exit 0
fi

count_files() {
  local root="$1"
  find "${root}" -type f | wc -l | tr -d ' '
}

prune_common_runtime_files() {
  local root="$1"

  find "${root}" -type f \
    \( \
      -name '*.d.ts' -o \
      -name '*.d.cts' -o \
      -name '*.d.mts' -o \
      -name '*.map' -o \
      \( -name '*.md' ! -name 'SKILL.md' ! -path '*/embedded-skills/*' \) -o \
      \( -name '*.markdown' ! -path '*/embedded-skills/*' \) -o \
      -name '*.pdb' -o \
      -name '*.tsbuildinfo' -o \
      -name '*.exp' -o \
      -name '*.lib' \
    \) \
    -delete

  find "${root}" -depth -type d \
    \( \
      -name '.github' -o \
      -name '.vscode' -o \
      -name '__tests__' -o \
      -name 'test' -o \
      -name 'tests' -o \
      -name 'example' -o \
      -name 'examples' -o \
      -name 'website' -o \
      -name 'coverage' -o \
      -name 'benchmark' -o \
      -name 'benchmarks' \
    \) \
    -exec rm -rf {} +

  # Keep docs under dependencies because some packages import code from doc/ paths.
  find "${root}" -depth -type d \
    \( \
      -name 'doc' -o \
      -name 'docs' \
    \) \
    ! -path '*/node_modules/*' \
    -exec rm -rf {} +
}

prune_koffi_binaries() {
  local root="$1"
  local platform="$2"

  case "${platform}" in
    macos)
      find "${root}" -depth -type d \
        \( \
          -path '*/node_modules/koffi/build/koffi/linux_*' -o \
          -path '*/node_modules/koffi/build/koffi/musl_*' -o \
          -path '*/node_modules/koffi/build/koffi/freebsd_*' -o \
          -path '*/node_modules/koffi/build/koffi/openbsd_*' -o \
          -path '*/node_modules/koffi/build/koffi/win32_*' \
        \) \
        -exec rm -rf {} +
      ;;
    linux)
      find "${root}" -depth -type d \
        \( \
          -path '*/node_modules/koffi/build/koffi/darwin_*' -o \
          -path '*/node_modules/koffi/build/koffi/freebsd_*' -o \
          -path '*/node_modules/koffi/build/koffi/openbsd_*' -o \
          -path '*/node_modules/koffi/build/koffi/win32_*' \
        \) \
        -exec rm -rf {} +
      ;;
  esac
}

prune_dangling_symlinks() {
  local root="$1"

  find "${root}" -type l ! -exec test -e {} \; -delete
}

before_count="$(count_files "${TARGET_ROOT}")"
prune_common_runtime_files "${TARGET_ROOT}"
if [ -n "${TARGET_PLATFORM}" ]; then
  prune_koffi_binaries "${TARGET_ROOT}" "${TARGET_PLATFORM}"
fi
prune_dangling_symlinks "${TARGET_ROOT}"
after_count="$(count_files "${TARGET_ROOT}")"

echo "pruned packaged tree at ${TARGET_ROOT} (${before_count} -> ${after_count} files)" >&2
