# Fingerprint Browser Profiles (AdsPower‑style) on the fingerprint browser engine

> Status: **Draft** · 2026‑07‑08 · Branch `feat/fingerprint-profiles` (off `release/2026.706`)
> Builds directly on [`migration-to-real-chrome.md`](./migration-to-real-chrome.md) — the Browser
> Profiles feature (launchable, agent‑drivable real Chrome per profile).

## Summary

Turn Browser Profiles into a **fingerprint browser** (anti‑detect, à la AdsPower / GoLogin /
Multilogin): each profile becomes a distinct, detection‑resistant browsing identity with its own
spoofed fingerprint (canvas/WebGL/audio/GPU/screen/UA/timezone/…), its own proxy, and its own
persistent logins.

The thesis that makes this cheap: **a profile already maps to one CDP‑driven Chromium process with a
stable per‑profile identity.** Swapping the spawned system‑Chrome binary for an OEM stealth‑browser
binary (a real Chromium with source‑level C++ fingerprint patches) is mostly a **binary‑selection +
spawn‑flags** change. The hard parts we already shipped — CDP driving, one‑window‑per‑profile,
per‑agent tab isolation, collision‑free debug ports, adopt‑if‑reachable, the reconcile poller — are
all engine‑agnostic and stay untouched.

**What we're building:** the fingerprint *engine wiring* + a *fingerprint‑template system with
import* + the *management UI*. i.e. AdsPower's per‑profile fingerprint model on our own engine —
**not** its cloud SaaS (no cloud sync, no team roles, no RPA robot).

---

## 0. The load‑bearing alignment (why this is cheap)

The stealth engine's fingerprint is **per‑process**, keyed by `--fingerprint=<seed>` (+ explicit
`--fingerprint-*` override flags) on the command line, and it is driven over CDP exactly like stock
Chromium. Our Browser Profiles already:

- spawn **one process per profile** with a stable per‑profile identity (persisted `debugPort`),
- drive it via Playwright `connectOverCDP` (`profile-cdp.ts`),
- enforce one window per profile, isolate agent tabs, reconcile on manual close, adopt a surviving
  process on relaunch.

So: **profile ⇄ one stealth‑browser process carrying a stable per‑profile fingerprint seed.** The only
new mechanics are (a) resolve the stealth‑browser binary, (b) append fingerprint flags to the spawn, and
(c) the templates + UI on top. Everything else is reused verbatim.

---

## 1. Data model — the profile *is* the fingerprint

Extend `BrowserProfile` (`apps/desktop/shared/browser-pane-protocol.ts`), persisted in
`browser-profiles/index.json` exactly like the `debugPort` field we just shipped.

```ts
export type ProfileEngine = "system" | "stealth";

export interface ProfileFingerprint {
  seed: number;                 // --fingerprint=<seed>; assigned ONCE at creation → returning identity
  platform: "windows" | "macos" | "linux";
  // Explicit overrides — omit → the binary derives the value from the seed.
  gpuVendor?: string;           // --fingerprint-gpu-vendor    e.g. "Intel Inc."
  gpuRenderer?: string;         // --fingerprint-gpu-renderer  e.g. "ANGLE (Intel, Intel(R) UHD ...)"
  hardwareConcurrency?: number; // --fingerprint-hardware-concurrency
  deviceMemory?: number;        // --fingerprint-device-memory (GB)
  screenWidth?: number;         // --fingerprint-screen-width
  screenHeight?: number;        // --fingerprint-screen-height
  brand?: "Chrome" | "Edge" | "Opera" | "Vivaldi"; // --fingerprint-brand
  brandVersion?: string;        // --fingerprint-brand-version
  platformVersion?: string;     // --fingerprint-platform-version (Client Hints)
  timezone?: string;            // --fingerprint-timezone (IANA)
  locale?: string;              // --fingerprint-locale (BCP‑47)
  noise?: boolean;              // false → --fingerprint-noise=false
  webrtcIp?: string | "auto";   // --fingerprint-webrtc-ip
  fontsDir?: string;            // --fingerprint-fonts-dir
  storageQuota?: number;        // --fingerprint-storage-quota (MB)
}

export interface BrowserProfile {
  /* …existing: id, name, createdAt, source, importedFrom?, debugPort?… */
  engine?: ProfileEngine;              // default "system"; "stealth" = fingerprinted
  fingerprint?: ProfileFingerprint;
  proxy?: { server: string; username?: string; password?: string; geoip?: boolean };
}
```

**Seed assignment** mirrors the `debugPort` collision‑free‑assign pattern in `profile-store.ts`: a
pure `assignProfileFingerprint(index, id)` helper that seeds once (`10000–99999`) at first
launch/creation and persists — same "assign‑once, stable‑forever" logic, unit‑testable the same way
as the port helpers.

**`buildFingerprintArgs(fp)`** turns the model into flags (single source of truth used by both the
spawn and the UI preview):

```ts
function buildFingerprintArgs(fp: ProfileFingerprint): string[] {
  const a = ["--no-sandbox", `--fingerprint=${fp.seed}`, `--fingerprint-platform=${fp.platform}`];
  const push = (flag: string, v: unknown) => { if (v !== undefined && v !== "") a.push(`${flag}=${v}`); };
  push("--fingerprint-gpu-vendor", fp.gpuVendor);
  push("--fingerprint-gpu-renderer", fp.gpuRenderer);
  push("--fingerprint-hardware-concurrency", fp.hardwareConcurrency);
  push("--fingerprint-device-memory", fp.deviceMemory);
  push("--fingerprint-screen-width", fp.screenWidth);
  push("--fingerprint-screen-height", fp.screenHeight);
  push("--fingerprint-brand", fp.brand);
  push("--fingerprint-brand-version", fp.brandVersion);
  push("--fingerprint-platform-version", fp.platformVersion);
  push("--fingerprint-timezone", fp.timezone);
  push("--fingerprint-locale", fp.locale);
  push("--fingerprint-storage-quota", fp.storageQuota);
  push("--fingerprint-fonts-dir", fp.fontsDir);
  push("--fingerprint-webrtc-ip", fp.webrtcIp);
  if (fp.noise === false) a.push("--fingerprint-noise=false");
  return a;
}
```

---

## 2. Fingerprint templates & import  ⭐ (in scope)

A **template** is a named, reusable fingerprint definition, decoupled from any one profile — the
building block of an AdsPower‑style workflow ("apply the *Windows 11 · Chrome · 1080p* fingerprint to
this profile," or "import this fingerprint someone shared and clone the identity").

### 2.1 Model & store

```ts
export interface FingerprintTemplate {
  id: string;                    // ftpl_<uuid>
  name: string;                  // "Windows 11 · Chrome 146 · 1080p"
  createdAt: string;
  source: "builtin" | "imported" | "captured" | "user";
  /** The fingerprint sans per‑profile seed. A template MAY pin a seed to reproduce an
   *  EXACT identity (clone); normally it doesn't, so each profile keeps its own seed. */
  fingerprint: Omit<ProfileFingerprint, "seed"> & { seed?: number };
}
```

Persisted to `browser-profiles/fingerprint-templates.json` via a **pure, leaf‑level store**
(`fingerprint-template-store.ts`) that mirrors `profile-store.ts`: `normalize…`, `add`, `rename`,
`remove`, `list`, `get` — no electron/fs/clock, fully unit‑testable. main.ts injects ids/timestamps
and does the fs work.

### 2.2 Applying a template to a profile

`applyTemplate(profile, template)` copies the template's fingerprint fields onto
`profile.fingerprint`. **Seed rule:** the profile keeps its own stable seed **unless** the template
pins one (`source: "captured"`/an explicit clone), in which case the pinned seed is copied so the
identity reproduces byte‑for‑byte. Applying also sets `engine: "stealth"`.

### 2.3 Import sources

| Source | Mechanism | Phase |
|---|---|---|
| **JSON file / paste** | File picker or textarea → `normalizeFingerprintTemplate(raw)` (§2.4). Our canonical schema + adapters for common exports. | P1 |
| **Built‑in preset library** | A curated in‑app `FINGERPRINT_PRESETS` array of **coherent** device profiles, shown as a gallery. "Use preset" → creates/applies a template. | P1 |
| **Capture from a real browser** | Launch a reference browser, read its true fingerprint over CDP/JS (navigator.\*, screen, WebGL `UNMASKED_VENDOR/RENDERER`, Intl timezone, fonts), save as a `captured` template — "clone my real device." | P4 |
| **External‑tool adapters** | Field‑map AdsPower / GoLogin / Multilogin export JSON → canonical schema (thin `adapters/*.ts`, extensible). | P3 |

### 2.4 Normalization + validation (the untrusted boundary)

Imported JSON is **untrusted input that becomes command‑line flags** — so normalization is a
**security gate**, not just tidy‑up (see §7). `normalizeFingerprintTemplate(raw)`:

1. **Whitelist keys** — drop anything not a known `ProfileFingerprint` field. No arbitrary flags ever
   reach the spawn.
2. **Enum‑validate** `platform` ∈ {windows,macos,linux}, `brand` ∈ {Chrome,Edge,Opera,Vivaldi}.
3. **Range‑clamp numerics** — `hardwareConcurrency` 1–64, `deviceMemory` ∈ {1,2,4,8,16,32},
   `screenWidth/Height` within sane bounds, `storageQuota` capped, `seed` 10000–99999.
4. **Charset‑validate strings** — `gpuVendor/gpuRenderer/brandVersion/platformVersion` must match a
   strict pattern (letters/digits/space/`.()-,/` only, length‑capped); reject `=`, `--`, control
   chars, newlines. `timezone` against an IANA set, `locale` against a BCP‑47 pattern.
5. Reject → drop the field and fall back to seed‑derived; surface a per‑field warning in the UI.

### 2.5 Export & round‑trip

`exportTemplate(profile | template)` → canonical JSON (and "Save profile's fingerprint as a
template"). Lets users share fingerprints and back them up. Round‑trips through §2.4 on re‑import.

### 2.6 Coherence check (a detection safeguard)

An internally inconsistent fingerprint is itself a tell (e.g. `platform: macos` + NVIDIA GPU, or a
Windows UA with a Mac screen ratio / non‑integer DPR). `validateCoherence(fp)` returns **warnings**
(non‑blocking) surfaced in the editor: platform↔GPU family, platform↔UA/brand, screen↔platform
typical resolutions, timezone↔locale plausibility. AdsPower does this server‑side; we do it inline.

---

## 3. Binary acquisition

The OEM stealth‑browser engine ships a ~200 MB **signed** binary (Ed25519‑verified), not something we
bundle.

| Option | How | Verdict |
|---|---|---|
| **A. Bring‑your‑own path** | User sets a binary‑path env var / a Settings field; we spawn it | **v1** — zero infra, proves the drop‑in |
| **B. Vendor package** | Add the vendor's package to `apps/desktop`; call its `ensureBinary()` / `binaryInfo()` to download + verify, then spawn the resolved path | **v2 (recommended)** — reuse their downloader; we just consume the path |
| **C. Replicate downloader** | Port download + Ed25519 verify into main | only if we refuse the dep |

Recommend **A → B**. `resolveStealthBinary()` returns the path (env override first, then the managed
cache). On macOS the binary is ad‑hoc signed → clear the quarantine xattr on download (see §9).

---

## 4. Launch wiring (the actual code change — small)

Two touch points in `apps/desktop/electron/main.ts`:

**(a) Binary selection** — new resolver, replacing the direct `findChromiumBinary` call in
`launchProfileChromium`:

```ts
function resolveProfileBrowserBinary(profile: BrowserProfile): string | null {
  return profile.engine === "stealth"
    ? resolveStealthBinary()
    : findChromiumBinary(profileLaunchFamily(profile.id)); // existing system‑Chrome path (incl. Win detection)
}
```

**(b) Spawn flags** — inject into the existing `spawn(...)` in `launchProfileChromium` (mirror in the
`openUrlInProfileWindow` fallback):

```ts
const fpArgs   = profile.engine === "stealth" ? buildFingerprintArgs(profile.fingerprint!) : [];
const proxyArgs = profile.proxy ? [`--proxy-server=${profile.proxy.server}`] : [];
const proc = spawn(binary, [
  `--user-data-dir=${userDataDir}`,
  `--remote-debugging-port=${port}`,
  "--no-first-run", "--no-default-browser-check",
  ...fpArgs, ...proxyArgs,
  "--new-window", landingUrl,
], { detached: true, stdio: "ignore" });
```

**Unchanged (the win):** `resolveProfileDebugPort`, `profileChromeUserDataDir`, the whole
`profile-cdp.ts` CDP driver, one‑window‑per‑profile, per‑agent tabs, reconcile poller, adopt. The
persisted seed also makes **adopt‑across‑restart correct** — we always relaunch a profile with the
same seed, so reconnecting to a surviving process yields the same identity.

---

## 5. UI — the management layer (the "AdsPower" surface; most of the work)

Extend `ProfilesPane.tsx`:

- **Per‑profile Fingerprint editor**
  - Engine toggle: **System Chrome ⇄ Stealth (fingerprinted)**
  - Identity: platform · seed (+ **🎲 Randomize** = new identity) · brand/version
  - Hardware: GPU vendor/renderer · cores · memory · screen W×H
  - Locale: timezone · locale (+ **match to proxy** = geoip)
  - Proxy: server + auth · geoip checkbox
  - Noise on/off
  - Live **flag preview** (from `buildFingerprintArgs`) + **coherence warnings** (§2.6)
- **Templates**
  - **Import** (file picker + paste JSON) → normalize (§2.4) → warnings → save/apply
  - **Preset gallery** (built‑in + user‑saved), "Apply to profile", "Save as template", "Export"
- **Test** button → launch the profile and open `browserscan.net` / `fingerprint-scan.com` /
  `creepjs` so the user visually verifies isolation.

IPC: `profiles:update` (fingerprint/proxy/engine payload) + `fptemplates:{list,import,create,rename,delete,apply,export}`, all through the existing `handleTrustedIpc` seam.

---

## 6. Per‑profile proxy + geoip

Folds in the previously‑noted "per‑profile proxy" hygiene item: `--proxy-server` per profile (§4b)
plus optional **geoip** → timezone/locale/WebRTC‑IP matched to the proxy exit IP (the engine's
`geoip` / `--fingerprint-webrtc-ip=auto`). Kills the classic "US proxy + UTC/en‑US" mismatch tell.

---

## 7. Security: fingerprint values are command‑line flags

Because every fingerprint field is interpolated into a `--fingerprint-*` flag on the spawned browser,
**imported/edited fingerprints are an argument‑injection surface.** Mitigations:

- **Array‑form spawn** (already how we launch) means a value never word‑splits into extra argv — a
  malicious `"x --disable-web-security"` arrives as one opaque arg, not two flags. This is the first
  line of defense but not sufficient (odd Chrome parsing, pathological values).
- **§2.4 normalization is mandatory** on *every* path that sets a fingerprint — import, paste,
  adapter, and manual edit — not just import. Key‑whitelist + enum + range‑clamp + charset + length
  caps. A value that fails validation is dropped, never passed through.
- **No raw‑flag passthrough** from templates. Templates carry *typed fields*, never arbitrary `args`.
  (Power users can still add raw `args` at the profile level, which is trusted local input.)
- Treat a shared template file like any untrusted download; the importer shows exactly what will be
  applied (flag preview) before it takes effect.

---

## 8. Fresh identities vs. imported logins (interaction with existing import)

Our existing "import from system Chrome" copies a real Chrome profile's cookies, which are encrypted
per‑browser‑family (macOS Keychain, Windows DPAPI). **Those cookies won't decrypt under the
stealth‑browser binary** (different family). Therefore:

- **Fingerprint (`stealth`) profiles are FRESH identities** — you log in *inside* them (exactly how
  AdsPower profiles work).
- **"Import from system Chrome" stays on the `system` engine.** `resolveProfileBrowserBinary` already
  lets both engines coexist per‑profile, so this is a clean split, not a conflict.

---

## 9. Gotchas & decisions

1. **macOS ad‑hoc signing** — Gatekeeper blocks the stealth binary on first launch. Clear the
   quarantine xattr on download, or document right‑click→Open. Handle in `resolveStealthBinary`.
2. **Don't spoof Windows‑on‑Mac** — the engine runs native‑platform on macOS (font/GPU mismatches
   otherwise). Default a profile's `platform` to the host on macOS; cross‑OS spoofing is a Linux‑host
   strength.
3. **`humanize` is wrapper‑only** — not in the binary. Our agent drives via CDP, so human‑like
   mouse/keyboard won't apply unless we port that layer. Out of scope for v1; follow‑up if behavioral
   detection matters.
4. **Binary staleness / cost** — the free binary trails ~1 Chromium version and goes stale vs.
   detection; latest needs a **Pro license**. Decide: BYO‑license vs. bundle. `--no-sandbox` is
   the engine's default — confirm we accept an unsandboxed profile browser (or drop it where the
   binary sandboxes cleanly).
5. **Dual‑use / ToS** — this is anti‑bot evasion. Legitimate for authorized automation / QA /
   permitted multi‑account use; needs a product‑level policy decision before shipping.

---

## 10. Phasing & verification

- **P0 — spike (½ day):** hardcode the stealth binary path, launch one profile with a fixed
  `--fingerprint`, drive it with the agent, open `browserscan.net` → confirm CDP works + the spoof
  shows. Proves the drop‑in with zero data‑model change.
- **P1 — data model + templates core:** `engine`/`fingerprint`/`proxy` on `BrowserProfile`;
  seed‑assign helper; `buildFingerprintArgs`; `fingerprint-template-store.ts` + `normalize…`
  (§2.4); built‑in preset library; JSON import/export. **Unit tests** mirror the port‑assignment
  tests (assign, normalize/sanitize, apply, coherence).
- **P2 — launch wiring:** `resolveProfileBrowserBinary` + spawn flags; per‑profile engine opt‑in.
- **P3 — binary management + adapters:** BYO path → vendor‑package managed download + macOS
  quarantine handling; AdsPower/GoLogin import adapters.
- **P4 — UI:** fingerprint editor + template gallery/import + Test button; capture‑from‑real‑browser.
- **P5 — proxy/geoip + verification harness:** two profiles, different seeds/proxies → assert
  distinct fingerprints on browserscan / CreepJS / FingerprintJS and independent logins.

### P0 result — ✅ PASS (2026‑07‑08 · free binary v145 · macOS arm64)

Ran a P0 spike — a raw `spawn` of the stealth binary (exactly like `launchProfileChromium`) + our
`playwright-core` `connectOverCDP` driver:

- **CDP driving works** against the raw‑spawned binary via our exact driver — no new transport.
- **`navigator.webdriver = false`**, and **platform spoofed to Windows** from this Mac (`Win32` +
  a `Chrome/145` Windows UA) with a coherent NVIDIA/ANGLE GPU.
- **Seed drives the fingerprint:** WebGL renderer = RTX 3060 (seed 12345) vs RTX 3090 (seed 67890) —
  **varies across seeds, stable for a fixed seed** (= a returning identity, per §1).
- **Finding:** with no timezone flag the browser leaked the *host* tz (`Asia/Shanghai`) under an
  `en-US` Windows identity — a coherence tell. Confirms **§6 (geoip) and §2.6 (coherence) are
  load‑bearing, not optional.** (Also: `--headless` blanks the 2D canvas, so use WebGL/audio — not
  canvas — as the seed‑variance signal in headless checks.)

**Conclusion:** the binary swap is a genuine drop‑in — the whole profile/tab/port/CDP stack works
unchanged. Cleared to proceed to **P1** (data model + templates).

**Verification is empirical:** the fingerprint must actually differ across two profiles and stay
consistent within one, checked against live fingerprinting sites — not just unit tests.

---

## 11. Out of scope (what makes AdsPower a *SaaS product*, not this)

Cloud profile sync · team roles / sharing · a hosted fingerprint *registry* · Firefox engine ·
built‑in proxy pool/rotation UI · RPA robot. We build **per‑profile fingerprints + templates + import
+ management UI on our own engine** — in scope now includes **template import/export & a preset
library**; cloud/team/RPA remain out.

---

## Appendix: fingerprint flag reference (from the engine's docs)

Default stealth args the wrapper sets: `--no-sandbox`, `--fingerprint=<random 10000‑99999>`,
`--fingerprint-platform=<windows|macos>`. Everything else is seed‑derived unless explicitly
overridden. Override flags used above: `--fingerprint-gpu-vendor|renderer`,
`--fingerprint-hardware-concurrency`, `--fingerprint-device-memory`,
`--fingerprint-screen-width|height`, `--fingerprint-brand|brand-version|platform-version`,
`--fingerprint-timezone|locale|location`, `--fingerprint-storage-quota`, `--fingerprint-taskbar-height`,
`--fingerprint-fonts-dir`, `--fingerprint-webrtc-ip=<ip|auto>`, `--fingerprint-noise=false`,
`--fingerprint=off` (pass‑through / real fingerprint). Seed model: fixed seed = returning identity;
random seed = fresh identity; per‑connection seeds over the engine's server mode (`?fingerprint=…`)
spawn a separate process per identity. **Noise vectors (canvas/WebGL/audio/clientRects) are
seed‑controlled, not value‑addressable** — you pick a seed, not a specific canvas hash.
