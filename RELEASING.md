# Releasing

## Release model

- Runtime bundles are published from GitHub Actions.
- Public release notes should summarize user-visible changes, packaging changes, and any migration or rollback concerns.
- Release tags should be immutable once published.

## Tag naming

- Use stable release tags for published releases.
- Do not reuse or move an existing published tag.

## Release notes

Release notes should cover:

- runtime changes
- desktop changes
- breaking changes
- setup or packaging changes

## Before release

- confirm required workflows are green
- confirm no secrets or private endpoints are present in committed files
- confirm docs reflect the current public setup flow

## macOS desktop DMG signing

- the macOS desktop DMG is built from the same GitHub Actions run that publishes the macOS runtime bundle
- the desktop packaging job consumes the runtime tarball artifact from that run instead of resolving `latest`
- unsigned fallback builds are allowed for OSS/internal testing when signing secrets are not configured
- for Apple Silicon test builds that intentionally skip Developer ID signing, prefer ad-hoc signing (`mac.identity=-`) instead of disabling signing entirely
- signed + notarized builds require GitHub Actions secrets:
  - `MAC_CERTIFICATE`: Developer ID Application certificate exported as `.p12` and stored as base64 or another `CSC_LINK`-compatible value
  - `MAC_CERTIFICATE_PASSWORD`: password for the exported certificate
  - `APPLE_ID`: Apple account used for notarization
  - `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for that Apple account
  - `APPLE_TEAM_ID`: Apple Developer team identifier
