/**
 * Build-time feature flags.
 *
 * `fingerprintBrowser` — the anti-detect / fingerprint ("cloak") Browser Profiles
 * engine. Gated OFF by default: the entry points (the 🛡 Fingerprint button)
 * show a Contact Sales popup instead of the editor, because the engine depends on
 * the proprietary CloakBrowser binary, which is OEM-licensed to bundle/ship (see
 * docs/cdp/fingerprint-profiles.md). The editor + template code stays intact
 * behind this flag — flip it to `true` for a customer/OEM build (where the
 * CloakBrowser binary is provisioned) and the full feature comes back.
 */
export const FEATURES: { fingerprintBrowser: boolean } = {
  // OFF by default. Enable for a customer/OEM build — or to test locally — with
  // `VITE_FINGERPRINT_BROWSER=true` (e.g. `VITE_FINGERPRINT_BROWSER=true npm run dev`).
  fingerprintBrowser:
    (import.meta.env as unknown as Record<string, string | undefined>)
      .VITE_FINGERPRINT_BROWSER === "true",
};
