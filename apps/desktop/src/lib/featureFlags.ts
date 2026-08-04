/**
 * Build-time feature flags.
 *
 * `fingerprintBrowser` — the anti-detect fingerprint Browser Profiles feature
 * (the `fingerprint` engine). Gated OFF by default: the entry points (the 🛡
 * Fingerprint button) show a Contact Sales popup instead of the editor, because
 * the engine is an ENTERPRISE feature — the OSS core loads the licensed
 * `@holaboss/fingerprint-ee` package (Camoufox, run out-of-process) at runtime
 * through the FingerprintBrowserEngine seam; absent (plain OSS builds), the
 * feature is off. Flip this to `true` for a licensed build to expose the UI.
 */
export const FEATURES: { fingerprintBrowser: boolean } = {
  // OFF by default. Enable for a licensed build — or to test locally — with
  // `VITE_FINGERPRINT_BROWSER=true` (e.g. `VITE_FINGERPRINT_BROWSER=true npm run dev`).
  fingerprintBrowser:
    (import.meta.env as unknown as Record<string, string | undefined>)
      .VITE_FINGERPRINT_BROWSER === "true",
};
