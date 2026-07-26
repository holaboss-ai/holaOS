import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProfileFingerprint } from "../../shared/browser-pane-protocol.js";
import {
  buildFingerprintArgs,
  coerceFingerprint,
  defaultFingerprint,
  sanitizeFingerprint,
  sanitizeProxy,
  validateFingerprintCoherence,
} from "./fingerprint.js";

test("buildFingerprintArgs emits the baseline + explicit overrides, omits undefined", () => {
  const args = buildFingerprintArgs({
    seed: 12345,
    platform: "windows",
    gpuVendor: "Google Inc. (NVIDIA)",
    hardwareConcurrency: 8,
  });
  // No --no-sandbox: it shows a desktop infobar + is a bot tell (dropped on purpose).
  assert.ok(!args.includes("--no-sandbox"));
  assert.ok(args.includes("--fingerprint=12345"));
  assert.ok(args.includes("--fingerprint-platform=windows"));
  assert.ok(args.includes("--fingerprint-gpu-vendor=Google Inc. (NVIDIA)"));
  assert.ok(args.includes("--fingerprint-hardware-concurrency=8"));
  // Unset fields produce no flag.
  assert.ok(!args.some((a) => a.startsWith("--fingerprint-device-memory")));
  assert.ok(!args.some((a) => a.startsWith("--fingerprint-locale")));
});

test("buildFingerprintArgs only adds the noise flag when noise === false", () => {
  assert.ok(
    buildFingerprintArgs({ seed: 1_0000, platform: "macos", noise: false }).includes(
      "--fingerprint-noise=false",
    ),
  );
  assert.ok(
    !buildFingerprintArgs({ seed: 1_0000, platform: "macos", noise: true }).some(
      (a) => a.startsWith("--fingerprint-noise"),
    ),
  );
});

test("sanitizeFingerprint keeps well-formed fields", () => {
  const { value, warnings } = sanitizeFingerprint({
    seed: 42069,
    platform: "windows",
    brand: "Edge",
    gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    hardwareConcurrency: 16,
    deviceMemory: 8,
    screenWidth: 1920,
    screenHeight: 1080,
    timezone: "America/New_York",
    locale: "en-US",
    webrtcIp: "auto",
    noise: false,
  });
  assert.equal(warnings.length, 0);
  assert.equal(value.seed, 42069);
  assert.equal(value.platform, "windows");
  assert.equal(value.brand, "Edge");
  assert.match(value.gpuRenderer ?? "", /RTX 3060/);
  assert.equal(value.hardwareConcurrency, 16);
  assert.equal(value.timezone, "America/New_York");
  assert.equal(value.webrtcIp, "auto");
  assert.equal(value.noise, false);
});

test("sanitizeFingerprint is a flag-injection gate: drops dangerous strings", () => {
  const { value, warnings } = sanitizeFingerprint({
    gpuVendor: "--disable-web-security", // leading -- → masquerades as a flag
    gpuRenderer: "Intel=x", // contains '=' → flag value confusion
    brandVersion: "1.0\n--foo", // newline / control
    platformVersion: "a; rm -rf /", // shell metachar not in allow-list
  });
  assert.equal(value.gpuVendor, undefined);
  assert.equal(value.gpuRenderer, undefined);
  assert.equal(value.brandVersion, undefined);
  assert.equal(value.platformVersion, undefined);
  assert.equal(warnings.length, 4);
});

test("sanitizeFingerprint clamps out-of-range numbers and bad enums, ignores unknown keys", () => {
  const { value, warnings } = sanitizeFingerprint({
    seed: 999, // < min
    platform: "android", // not an enum member
    hardwareConcurrency: 9999, // > max
    brand: "Firefox", // not an enum member
    somethingEvil: "--foo", // unknown key → ignored entirely
  });
  assert.equal(value.seed, undefined);
  assert.equal(value.platform, undefined);
  assert.equal(value.hardwareConcurrency, undefined);
  assert.equal(value.brand, undefined);
  assert.ok(!("somethingEvil" in value));
  // 4 declared-but-invalid fields warned; the unknown key is silently ignored.
  assert.equal(warnings.length, 4);
});

test("coerceFingerprint requires a usable identity (seed + platform)", () => {
  assert.equal(coerceFingerprint({ platform: "windows" }), null);
  assert.equal(coerceFingerprint({ seed: 12345 }), null);
  const fp = coerceFingerprint({ seed: 12345, platform: "macos", brand: "Chrome" });
  assert.equal(fp?.seed, 12345);
  assert.equal(fp?.platform, "macos");
  assert.equal(fp?.brand, "Chrome");
});

test("sanitizeProxy validates the server and preserves auth/geoip", () => {
  assert.equal(sanitizeProxy({ server: "" }), null);
  assert.equal(sanitizeProxy({ server: "http://ok bad" }), null); // whitespace
  const p = sanitizeProxy({
    server: "socks5://host:1080",
    username: "u",
    password: "p",
    geoip: true,
  });
  assert.equal(p?.server, "socks5://host:1080");
  assert.equal(p?.username, "u");
  assert.equal(p?.geoip, true);
});

test("validateFingerprintCoherence flags mismatches, passes coherent identities", () => {
  const macNvidia: ProfileFingerprint = {
    seed: 12345,
    platform: "macos",
    gpuRenderer: "ANGLE (NVIDIA, RTX 3060 Direct3D11)",
  };
  assert.ok(validateFingerprintCoherence(macNvidia).length >= 1);

  const localeTz: ProfileFingerprint = {
    seed: 12345,
    platform: "windows",
    locale: "en-US",
    timezone: "Asia/Shanghai",
  };
  assert.ok(
    validateFingerprintCoherence(localeTz).some((w) => /geoip/.test(w)),
  );

  const coherent = defaultFingerprint(12345, "windows");
  assert.deepEqual(validateFingerprintCoherence(coherent), []);
});
