/**
 * Built-in fingerprint preset library — the "pick a realistic device" gallery.
 *
 * Each preset is a COHERENT device profile (platform ↔ typical hardware/screen ↔
 * brand), deliberately WITHOUT a pinned GPU or seed: the fingerprint engine derives
 * a coherent GPU from platform + the profile's own seed, and each profile keeps its
 * own seed (its returning identity). `createdAt` is empty — these are static, not
 * user-created.
 */
import type { FingerprintTemplate } from "../../shared/browser-pane-protocol.js";

export const FINGERPRINT_PRESETS: readonly FingerprintTemplate[] = [
  {
    id: "ftpl_builtin_win11_chrome_1080p",
    name: "Windows 11 · Chrome · 1080p",
    createdAt: "",
    source: "builtin",
    fingerprint: {
      platform: "windows",
      brand: "Chrome",
      hardwareConcurrency: 8,
      deviceMemory: 8,
      screenWidth: 1920,
      screenHeight: 1080,
      locale: "en-US",
    },
  },
  {
    id: "ftpl_builtin_win11_edge_1440p",
    name: "Windows 11 · Edge · 1440p",
    createdAt: "",
    source: "builtin",
    fingerprint: {
      platform: "windows",
      brand: "Edge",
      hardwareConcurrency: 16,
      deviceMemory: 16,
      screenWidth: 2560,
      screenHeight: 1440,
      locale: "en-US",
    },
  },
  {
    id: "ftpl_builtin_win10_chrome_768p",
    name: "Windows 10 · Chrome · Laptop 768p",
    createdAt: "",
    source: "builtin",
    fingerprint: {
      platform: "windows",
      brand: "Chrome",
      hardwareConcurrency: 4,
      deviceMemory: 8,
      screenWidth: 1366,
      screenHeight: 768,
      locale: "en-US",
    },
  },
  {
    id: "ftpl_builtin_macos_chrome_retina",
    name: "macOS · Chrome · Retina",
    createdAt: "",
    source: "builtin",
    fingerprint: {
      platform: "macos",
      brand: "Chrome",
      hardwareConcurrency: 10,
      deviceMemory: 16,
      screenWidth: 1512,
      screenHeight: 982,
      locale: "en-US",
    },
  },
];
