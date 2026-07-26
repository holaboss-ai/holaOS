#!/usr/bin/env bash
# Builds the signed macOS release artifacts (zip + DMG + updater manifests)
# from a notarized prepackaged .app bundle.
#
# DMG and zip are built as separate electron-builder passes to work around a
# packing bug that stripped the Electron Framework main binary from the DMG
# when both targets were packed in a single `--mac dmg zip` call (shipped on
# holaOS-2026.608.2, see commit history).
#
# The split has a manifest race: the zip pass writes the `*-mac.yml` updater
# manifests with the zip in `files:` and the dmg pass overwrites them with a
# dmg-only `files:` list. We save the zip-pass manifests aside, run the dmg
# pass, then merge each pair back into the dmg-pass file via the existing
# merge-mac-update-manifests.rb so `files:` ends up with both entries. The
# zip manifest is the merge primary so `files[0]` and the top-level
# `path:`/`sha512:` remain the zip — matches the original combined output
# (auto-updaters prefer the zip for downloads; the DMG is for first install).

set -euo pipefail

app_path="${1:-}"
arch_flag="${2:-}"
if [ -z "${app_path}" ] || [ -z "${arch_flag}" ]; then
  echo "Usage: build-mac-release-artifacts.sh <app_path> <--arm64|--x64>" >&2
  exit 1
fi
if [ ! -d "${app_path}" ]; then
  echo "prepackaged app bundle does not exist: ${app_path}" >&2
  exit 1
fi
case "${arch_flag}" in
  --arm64|--x64) ;;
  *)
    echo "unexpected arch flag (expected --arm64 or --x64): ${arch_flag}" >&2
    exit 1
    ;;
esac

scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "${scripts_dir}/.." && pwd)"
release_dir="${project_dir}/out/release"

rm -rf "${release_dir}"

node "${scripts_dir}/run-electron-builder.mjs" \
  --projectDir "${project_dir}" \
  --publish never \
  --prepackaged "${app_path}" \
  --mac zip \
  "${arch_flag}" \
  --config.mac.notarize=false

zip_manifest_backup_dir="$(mktemp -d)"
trap 'rm -rf "${zip_manifest_backup_dir}"' EXIT
manifest_count=0
while IFS= read -r manifest_path; do
  cp "${manifest_path}" "${zip_manifest_backup_dir}/$(basename "${manifest_path}")"
  manifest_count=$((manifest_count + 1))
done < <(find "${release_dir}" -maxdepth 1 -name '*-mac.yml' -print)
if [ "${manifest_count}" -eq 0 ]; then
  echo "zip pass did not produce any *-mac.yml updater manifests in ${release_dir}" >&2
  exit 1
fi

node "${scripts_dir}/run-electron-builder.mjs" \
  --projectDir "${project_dir}" \
  --publish never \
  --prepackaged "${app_path}" \
  --mac dmg \
  "${arch_flag}" \
  --config.mac.notarize=false

while IFS= read -r dmg_manifest_path; do
  manifest_name="$(basename "${dmg_manifest_path}")"
  zip_manifest_path="${zip_manifest_backup_dir}/${manifest_name}"
  if [ ! -f "${zip_manifest_path}" ]; then
    echo "missing zip-pass backup for ${manifest_name}" >&2
    exit 1
  fi
  merged_tmp="$(mktemp)"
  ruby "${scripts_dir}/merge-mac-update-manifests.rb" \
    "${merged_tmp}" \
    "${zip_manifest_path}" \
    "${dmg_manifest_path}"
  mv "${merged_tmp}" "${dmg_manifest_path}"
done < <(find "${release_dir}" -maxdepth 1 -name '*-mac.yml' -print)
