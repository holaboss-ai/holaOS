# Desktop (Electron App)

## Installing apps from the Marketplace

The `Marketplace → Apps` sub-tab lists installable modules from either the
marketplace (extended `/api/v1/marketplace/app-templates` with per-target
`archives`) or a local `hola-boss-apps/dist/` checkout. Install flow: the
desktop downloads the tarball to `os.tmpdir()/holaboss-app-archives/`, then
POSTs to the runtime's `/api/v1/apps/install-archive`, which extracts under
`apps/{appId}/`, registers the app in `workspace.yaml`, and starts it through
the normal lifecycle. See `docs/plans/2026-04-09-desktop-install-app-design.md`.
