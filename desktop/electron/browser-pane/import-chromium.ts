/**
 * Chromium-family (Chrome / Chromium / Arc) profile import helpers.
 *
 * Pure / stateful-only-via-arg helpers used by the profile-import IPC flow.
 * No coupling to electron `mainWindow`, workspace state maps, or persistence
 * — those live behind the orchestration entrypoints in `import-browsers.ts`.
 *
 * Extracted from `electron/main.ts` (BP-P2a). Behaviour is unchanged.
 */
import { execFileSync } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomUUID,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import {
  dialog,
  session,
  type BrowserWindow,
  type OpenDialogOptions,
  type Session,
} from "electron";

import type {
  BrowserBookmarkPayload,
  BrowserCookieImportSummary,
  BrowserHistoryEntryPayload,
  ChromeBookmarkNodePayload,
  ChromiumFamilyBrowser,
  ChromiumProfileSelection,
} from "./types.js";

/** Soft cap on how many history rows we copy into a workspace per profile. */
export const CHROME_HISTORY_IMPORT_LIMIT = 500;

const CHROME_COOKIE_SAFE_STORAGE_SERVICE_NAMES = [
  "Chrome Safe Storage",
  "Google Chrome Safe Storage",
];
const CHROME_COOKIE_SAFE_STORAGE_ACCOUNT_NAMES = ["Chrome", "Google Chrome"];
const CHROME_COOKIE_PBKDF2_SALT = "saltysalt";
const CHROME_COOKIE_CBC_IV = Buffer.alloc(16, 0x20);
const CHROME_WINDOWS_DPAPI_KEY_PREFIX = "DPAPI";
const CHROME_WINDOWS_COOKIE_AEAD_PREFIXES = new Set(["v10", "v11"]);
const CHROME_WINDOWS_APP_BOUND_COOKIE_PREFIX = "v20";
const BROWSER_IMPORT_PROFILE_DIR_PATTERNS = [
  /^Default$/,
  /^Profile \d+$/,
  /^Profile [A-Za-z0-9_-]+$/,
  /^Guest Profile$/,
];

function utcNowIso() {
  return new Date().toISOString();
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Filter to the set of urls we deem "trackable" in browser history. */
export function shouldTrackHistoryUrlForImport(rawUrl: string): boolean {
  if (!rawUrl) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function chromiumFamilyDisplayName(browser: ChromiumFamilyBrowser) {
  switch (browser) {
    case "chromium":
      return "Chromium";
    case "arc":
      return "Arc";
    default:
      return "Chrome";
  }
}

export function chromiumFamilyUserDataRootCandidates(
  browser: ChromiumFamilyBrowser,
): string[] {
  const localAppData =
    process.env.LOCALAPPDATA?.trim() ||
    path.join(os.homedir(), "AppData", "Local");
  const configHome =
    process.env.XDG_CONFIG_HOME?.trim() ||
    path.join(os.homedir(), ".config");

  switch (process.platform) {
    case "darwin":
      if (browser === "chromium") {
        return [
          path.join(os.homedir(), "Library", "Application Support", "Chromium"),
        ];
      }
      if (browser === "arc") {
        return [
          path.join(os.homedir(), "Library", "Application Support", "Arc"),
        ];
      }
      return [
        path.join(
          os.homedir(),
          "Library",
          "Application Support",
          "Google",
          "Chrome",
        ),
      ];
    case "win32":
      if (browser === "chromium") {
        return [path.join(localAppData, "Chromium", "User Data")];
      }
      if (browser === "arc") {
        return [
          path.join(localAppData, "Arc", "User Data"),
          path.join(localAppData, "TheBrowserCompany", "Arc", "User Data"),
          path.join(
            localAppData,
            "Packages",
            "TheBrowserCompany.Arc_ttt1ap7aakyb4",
            "LocalCache",
            "Local",
            "Arc",
            "User Data",
          ),
        ];
      }
      return [path.join(localAppData, "Google", "Chrome", "User Data")];
    case "linux":
      if (browser === "chromium") {
        return [path.join(configHome, "chromium")];
      }
      if (browser === "arc") {
        return [path.join(configHome, "arc"), path.join(configHome, "Arc")];
      }
      return [path.join(configHome, "google-chrome")];
    default:
      return [];
  }
}

export function resolveChromiumFamilyUserDataRoot(
  browser: ChromiumFamilyBrowser,
): string | null {
  for (const candidate of chromiumFamilyUserDataRootCandidates(browser)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return chromiumFamilyUserDataRootCandidates(browser)[0] ?? null;
}

export function resolveChromeUserDataRoot(): string | null {
  return resolveChromiumFamilyUserDataRoot("chrome");
}

export function chromeLocalStatePath(userDataDir: string) {
  return path.join(userDataDir, "Local State");
}

export function chromeProfileBookmarksPath(profileDir: string) {
  return path.join(profileDir, "Bookmarks");
}

export function chromeProfileHistoryPath(profileDir: string) {
  return path.join(profileDir, "History");
}

export function chromeProfileCookiesPath(profileDir: string) {
  const candidates = [
    path.join(profileDir, "Network", "Cookies"),
    path.join(profileDir, "Cookies"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function chromeProfileHasImportableData(profileDir: string) {
  return (
    existsSync(chromeProfileBookmarksPath(profileDir)) ||
    existsSync(chromeProfileHistoryPath(profileDir)) ||
    Boolean(chromeProfileCookiesPath(profileDir))
  );
}

export function chromeProfileLabelFromInfo(
  info: Record<string, unknown> | null | undefined,
  profileId: string,
) {
  const candidates = [
    typeof info?.name === "string" ? info.name.trim() : "",
    typeof info?.shortcut_name === "string" ? info.shortcut_name.trim() : "",
    typeof info?.gaia_name === "string" ? info.gaia_name.trim() : "",
    typeof info?.user_name === "string" ? info.user_name.trim() : "",
  ];
  return candidates.find(Boolean) || profileId;
}

export async function selectChromiumFamilyProfileDirectory(
  browser: ChromiumFamilyBrowser,
  defaultPath: string | null,
  ownerWindow: BrowserWindow | null,
): Promise<string | null> {
  const browserDisplayName = chromiumFamilyDisplayName(browser);
  const options: OpenDialogOptions = {
    title: `Select ${browserDisplayName} Profile Folder`,
    buttonLabel: "Import From This Profile",
    properties: ["openDirectory"],
    defaultPath: defaultPath ?? undefined,
    message:
      `Choose a ${browserDisplayName} profile folder such as Default or Profile 1.`,
  };
  const validOwner =
    ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow : undefined;
  const result = validOwner
    ? await dialog.showOpenDialog(validOwner, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0]?.trim() || null;
}

export async function readChromiumFamilyProfileMetadata(
  userDataDir: string | null,
) {
  const parsedLocalState =
    userDataDir && existsSync(chromeLocalStatePath(userDataDir))
      ? await readJsonFile<Record<string, unknown>>(
          chromeLocalStatePath(userDataDir),
          {},
        )
      : {};
  const profileSection =
    parsedLocalState.profile &&
    typeof parsedLocalState.profile === "object" &&
    !Array.isArray(parsedLocalState.profile)
      ? (parsedLocalState.profile as Record<string, unknown>)
      : {};
  const infoCache =
    profileSection.info_cache &&
    typeof profileSection.info_cache === "object" &&
    !Array.isArray(profileSection.info_cache)
      ? (profileSection.info_cache as Record<string, Record<string, unknown>>)
      : {};
  const lastUsedProfileId =
    typeof profileSection.last_used === "string"
      ? profileSection.last_used.trim()
      : "";
  const lastActiveProfiles = Array.isArray(profileSection.last_active_profiles)
    ? profileSection.last_active_profiles
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];
  return {
    infoCache,
    lastUsedProfileId,
    lastActiveProfiles,
  };
}

export async function discoverChromiumFamilyImportProfiles(
  browser: ChromiumFamilyBrowser,
): Promise<{
  userDataDir: string | null;
  infoCache: Record<string, Record<string, unknown>>;
  profiles: ChromiumProfileSelection[];
}> {
  const userDataDir = resolveChromiumFamilyUserDataRoot(browser);
  const { infoCache, lastUsedProfileId, lastActiveProfiles } =
    await readChromiumFamilyProfileMetadata(userDataDir);

  if (userDataDir && existsSync(userDataDir)) {
    const candidateProfileIds = new Set<string>();
    if (lastUsedProfileId) {
      candidateProfileIds.add(lastUsedProfileId);
    }
    for (const profileId of lastActiveProfiles) {
      candidateProfileIds.add(profileId);
    }
    candidateProfileIds.add("Default");

    try {
      const childEntries = await fs.readdir(userDataDir, {
        withFileTypes: true,
      });
      for (const entry of childEntries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (BROWSER_IMPORT_PROFILE_DIR_PATTERNS.some((pattern) => pattern.test(entry.name))) {
          candidateProfileIds.add(entry.name);
        }
      }
    } catch {
      // Fall back to Local State candidates below.
    }

    const importableProfiles: ChromiumProfileSelection[] = [];
    for (const profileId of candidateProfileIds) {
      const profileDir = path.join(userDataDir, profileId);
      if (!existsSync(profileDir) || !chromeProfileHasImportableData(profileDir)) {
        continue;
      }
      importableProfiles.push({
        browser,
        userDataDir,
        profileId,
        profileDir,
        profileLabel: chromeProfileLabelFromInfo(infoCache[profileId], profileId),
      });
    }
    return {
      userDataDir,
      infoCache,
      profiles: importableProfiles,
    };
  }

  return {
    userDataDir,
    infoCache,
    profiles: [],
  };
}

function matchChromiumProfileByDirectory(
  profiles: ChromiumProfileSelection[],
  selectedProfileDir: string,
) {
  const selectedProfileId = path.basename(selectedProfileDir);
  return (
    profiles.find(
      (profile) =>
        profile.profileDir === selectedProfileDir ||
        profile.profileId === selectedProfileId,
    ) ?? null
  );
}

export async function resolveChromiumFamilyProfileSelection(
  browser: ChromiumFamilyBrowser,
  preferredProfileDir: string | null | undefined,
  ownerWindow: BrowserWindow | null,
): Promise<ChromiumProfileSelection | null> {
  const { userDataDir, infoCache, profiles } =
    await discoverChromiumFamilyImportProfiles(browser);

  const preferredDir =
    typeof preferredProfileDir === "string" ? preferredProfileDir.trim() : "";
  if (preferredDir) {
    const matched = matchChromiumProfileByDirectory(profiles, preferredDir);
    if (matched) {
      return matched;
    }
    if (!chromeProfileHasImportableData(preferredDir)) {
      throw new Error(
        "Selected profile does not contain importable bookmarks, history, or cookies.",
      );
    }
    const selectedProfileId = path.basename(preferredDir);
    return {
      browser,
      userDataDir: path.dirname(preferredDir),
      profileId: selectedProfileId,
      profileDir: preferredDir,
      profileLabel: chromeProfileLabelFromInfo(
        infoCache[selectedProfileId],
        selectedProfileId,
      ),
    };
  }

  if (profiles.length === 1) {
    return profiles[0];
  }

  if (profiles.length > 1) {
    const selectedProfileDir = await selectChromiumFamilyProfileDirectory(
      browser,
      userDataDir,
      ownerWindow,
    );
    if (!selectedProfileDir) {
      return null;
    }
    const matchedProfile = matchChromiumProfileByDirectory(
      profiles,
      selectedProfileDir,
    );
    if (matchedProfile) {
      return matchedProfile;
    }
    if (!chromeProfileHasImportableData(selectedProfileDir)) {
      throw new Error(
        "Selected profile does not contain importable bookmarks, history, or cookies.",
      );
    }

    const selectedProfileId = path.basename(selectedProfileDir);
    return {
      browser,
      userDataDir: path.dirname(selectedProfileDir),
      profileId: selectedProfileId,
      profileDir: selectedProfileDir,
      profileLabel: chromeProfileLabelFromInfo(
        infoCache[selectedProfileId],
        selectedProfileId,
      ),
    };
  }

  const selectedProfileDir = await selectChromiumFamilyProfileDirectory(
    browser,
    userDataDir,
    ownerWindow,
  );
  if (!selectedProfileDir) {
    return null;
  }

  const profileId = path.basename(selectedProfileDir);
  const resolvedUserDataDir = path.dirname(selectedProfileDir);
  return {
    browser,
    userDataDir: resolvedUserDataDir,
    profileId,
    profileDir: selectedProfileDir,
    profileLabel: chromeProfileLabelFromInfo(infoCache[profileId], profileId),
  };
}

export async function resolveChromeProfileSelection(
  ownerWindow: BrowserWindow | null,
): Promise<ChromiumProfileSelection | null> {
  return resolveChromiumFamilyProfileSelection("chrome", null, ownerWindow);
}

function parseChromeTimestampMicros(
  rawValue: string | number | bigint | null | undefined,
) {
  if (
    rawValue == null ||
    rawValue === "" ||
    rawValue === 0 ||
    rawValue === 0n
  ) {
    return null;
  }
  try {
    return BigInt(rawValue);
  } catch {
    return null;
  }
}

export function chromeTimestampMicrosToIso(
  rawValue: string | number | bigint | null | undefined,
) {
  const micros = parseChromeTimestampMicros(rawValue);
  if (!micros || micros <= 0n) {
    return null;
  }
  const unixMicros = micros - 11644473600000000n;
  if (unixMicros <= 0n) {
    return null;
  }
  return new Date(Number(unixMicros / 1000n)).toISOString();
}

export function importedCookieUrl(
  hostKey: string,
  cookiePath: string,
  secure: boolean,
) {
  const normalizedHost = hostKey.trim().replace(/^\.+/, "");
  if (!normalizedHost) {
    return null;
  }
  try {
    return new URL(
      `${secure ? "https" : "http"}://${normalizedHost}${cookiePath || "/"}`,
    ).toString();
  } catch {
    return null;
  }
}

export function chromeSameSiteToElectronSameSite(
  value: number | null | undefined,
): "unspecified" | "no_restriction" | "lax" | "strict" {
  switch (value) {
    case 0:
      return "no_restriction";
    case 1:
      return "lax";
    case 2:
      return "strict";
    default:
      return "unspecified";
  }
}

export function chromeEncryptedCookieVersion(encryptedValue: Buffer) {
  if (encryptedValue.length < 3) {
    return null;
  }
  const prefix = encryptedValue.subarray(0, 3).toString("utf8");
  return /^v\d\d$/.test(prefix) ? prefix : null;
}

function readChromeSafeStoragePasswordMac() {
  for (const serviceName of CHROME_COOKIE_SAFE_STORAGE_SERVICE_NAMES) {
    for (const accountName of CHROME_COOKIE_SAFE_STORAGE_ACCOUNT_NAMES) {
      try {
        const password = execFileSync(
          "security",
          [
            "find-generic-password",
            "-w",
            "-s",
            serviceName,
            "-a",
            accountName,
          ],
          { encoding: "utf8" },
        ).trim();
        if (password) {
          return password;
        }
      } catch {
        // Try the next service/account pair.
      }
    }

    try {
      const password = execFileSync(
        "security",
        ["find-generic-password", "-w", "-s", serviceName],
        { encoding: "utf8" },
      ).trim();
      if (password) {
        return password;
      }
    } catch {
      // Try the next service name.
    }
  }

  throw new Error(
    "Chrome Safe Storage key was not found in the macOS keychain.",
  );
}

export function readChromeWindowsEncryptedKey(userDataDir: string) {
  const localStatePath = chromeLocalStatePath(userDataDir);
  if (!existsSync(localStatePath)) {
    throw new Error("Chrome Local State was not found.");
  }
  const parsed = JSON.parse(
    readFileSync(localStatePath, "utf8"),
  ) as Record<string, unknown>;
  const osCrypt =
    parsed.os_crypt &&
    typeof parsed.os_crypt === "object" &&
    !Array.isArray(parsed.os_crypt)
      ? (parsed.os_crypt as Record<string, unknown>)
      : null;
  const encodedKey =
    typeof osCrypt?.encrypted_key === "string"
      ? osCrypt.encrypted_key.trim()
      : "";
  if (!encodedKey) {
    throw new Error("Chrome Local State did not contain os_crypt.encrypted_key.");
  }
  const encryptedKeyWithHeader = Buffer.from(encodedKey, "base64");
  const header = Buffer.from(CHROME_WINDOWS_DPAPI_KEY_PREFIX, "utf8");
  if (!encryptedKeyWithHeader.subarray(0, header.length).equals(header)) {
    throw new Error("Chrome os_crypt.encrypted_key did not use the DPAPI format.");
  }
  return encryptedKeyWithHeader.subarray(header.length);
}

function runPowerShellScriptSync(command: string) {
  const shells = ["powershell.exe", "powershell"];
  let lastError: unknown = null;
  for (const shellName of shells) {
    try {
      return execFileSync(
        shellName,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          command,
        ],
        { encoding: "utf8" },
      ).trim();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("PowerShell was not available.");
}

function decryptWindowsDpapi(input: Buffer) {
  const base64Input = input.toString("base64");
  const command = [
    "$ErrorActionPreference='Stop'",
    `Add-Type -AssemblyName System.Security`,
    `$bytes=[Convert]::FromBase64String('${base64Input}')`,
    `$plaintext=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    `[Convert]::ToBase64String($plaintext)`,
  ].join(";");
  const output = runPowerShellScriptSync(command);
  if (!output) {
    throw new Error("Windows DPAPI decryption returned an empty result.");
  }
  return Buffer.from(output, "base64");
}

export function decryptChromeCookieValueWindows(
  encryptedValue: Buffer,
  encryptionKey: Buffer,
) {
  const version = chromeEncryptedCookieVersion(encryptedValue);
  if (!version || !CHROME_WINDOWS_COOKIE_AEAD_PREFIXES.has(version)) {
    throw new Error("Unsupported Windows Chrome cookie encryption format.");
  }
  const nonceOffset = version.length;
  const nonceLength = 12;
  const authTagLength = 16;
  if (encryptedValue.length <= nonceOffset + nonceLength + authTagLength) {
    throw new Error("Windows Chrome cookie value was too short to decrypt.");
  }
  const nonce = encryptedValue.subarray(nonceOffset, nonceOffset + nonceLength);
  const encryptedPayload = encryptedValue.subarray(nonceOffset + nonceLength);
  const ciphertext = encryptedPayload.subarray(
    0,
    encryptedPayload.length - authTagLength,
  );
  const authTag = encryptedPayload.subarray(
    encryptedPayload.length - authTagLength,
  );
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
}

function decryptChromeCookieValueMac(
  encryptedValue: Buffer,
  safeStoragePassword: string,
) {
  const version = chromeEncryptedCookieVersion(encryptedValue);
  if (!version) {
    throw new Error("Unsupported Chrome cookie encryption format.");
  }
  const key = pbkdf2Sync(
    safeStoragePassword,
    CHROME_COOKIE_PBKDF2_SALT,
    1003,
    16,
    "sha1",
  );
  const decipher = createDecipheriv(
    "aes-128-cbc",
    key,
    CHROME_COOKIE_CBC_IV,
  );
  decipher.setAutoPadding(true);
  return Buffer.concat([
    decipher.update(encryptedValue.subarray(version.length)),
    decipher.final(),
  ]);
}

export function stripChromeCookieDomainHashPrefix(
  hostKey: string,
  decryptedValue: Buffer,
) {
  const domainHash = createHash("sha256").update(hostKey, "utf8").digest();
  if (
    decryptedValue.length >= domainHash.length &&
    decryptedValue.subarray(0, domainHash.length).equals(domainHash)
  ) {
    return decryptedValue.subarray(domainHash.length);
  }
  return decryptedValue;
}

export function decodeChromeCookieValue(
  hostKey: string,
  decryptedValue: Buffer,
) {
  const valueBytes = stripChromeCookieDomainHashPrefix(hostKey, decryptedValue);
  return valueBytes.toString("utf8");
}

function collectChromeBookmarkEntries(
  node: ChromeBookmarkNodePayload,
  bucket: BrowserBookmarkPayload[],
) {
  if (node.type === "url" && typeof node.url === "string" && node.url.trim()) {
    bucket.push({
      id: `bookmark-import-${randomUUID()}`,
      url: node.url.trim(),
      title: typeof node.name === "string" && node.name.trim()
        ? node.name.trim()
        : node.url.trim(),
      createdAt: chromeTimestampMicrosToIso(node.date_added) ?? utcNowIso(),
    });
    return;
  }

  if (!Array.isArray(node.children)) {
    return;
  }
  for (const child of node.children) {
    if (child && typeof child === "object") {
      collectChromeBookmarkEntries(child, bucket);
    }
  }
}

export async function readChromeBookmarks(
  profileDir: string,
): Promise<BrowserBookmarkPayload[]> {
  const bookmarksPath = chromeProfileBookmarksPath(profileDir);
  if (!existsSync(bookmarksPath)) {
    return [];
  }

  const parsed = await readJsonFile<Record<string, unknown>>(bookmarksPath, {});
  const roots =
    parsed.roots && typeof parsed.roots === "object" && !Array.isArray(parsed.roots)
      ? (parsed.roots as Record<string, ChromeBookmarkNodePayload>)
      : {};
  const bookmarks: BrowserBookmarkPayload[] = [];
  for (const root of Object.values(roots)) {
    if (root && typeof root === "object") {
      collectChromeBookmarkEntries(root, bookmarks);
    }
  }
  return bookmarks;
}

export async function copyChromeProfileDatabaseToTemp(
  sourcePath: string,
  tempPrefix: string,
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), tempPrefix));
  const copiedPath = path.join(tempDir, path.basename(sourcePath));
  await fs.copyFile(sourcePath, copiedPath);
  for (const suffix of ["-wal", "-shm"]) {
    const sourceCompanionPath = `${sourcePath}${suffix}`;
    if (!existsSync(sourceCompanionPath)) {
      continue;
    }
    await fs.copyFile(
      sourceCompanionPath,
      `${copiedPath}${suffix}`,
    ).catch(() => undefined);
  }
  return {
    copiedPath,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    },
  };
}

export async function readChromeHistory(
  profileDir: string,
): Promise<BrowserHistoryEntryPayload[]> {
  const historyPath = chromeProfileHistoryPath(profileDir);
  if (!existsSync(historyPath)) {
    return [];
  }

  const { copiedPath, cleanup } = await copyChromeProfileDatabaseToTemp(
    historyPath,
    "holaboss-chrome-history-",
  );

  try {
    const database = new Database(copiedPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const rows = database
        .prepare(
          `
          SELECT
            url,
            title,
            visit_count,
            CAST(last_visit_time AS TEXT) AS last_visit_time
          FROM urls
          WHERE hidden = 0
          ORDER BY last_visit_time DESC
          LIMIT ?
        `,
        )
        .all(
          CHROME_HISTORY_IMPORT_LIMIT,
        ) as Array<{
          url: string;
          title: string | null;
          visit_count: number;
          last_visit_time: string;
        }>;

      return rows
        .map((row) => {
          const url = row.url.trim();
          if (!shouldTrackHistoryUrlForImport(url)) {
            return null;
          }
          const lastVisitedAt =
            chromeTimestampMicrosToIso(row.last_visit_time) ?? utcNowIso();
          return {
            id: `history-import-${randomUUID()}`,
            url,
            title: row.title?.trim() || url,
            visitCount:
              Number.isFinite(row.visit_count) && row.visit_count > 0
                ? row.visit_count
                : 1,
            createdAt: lastVisitedAt,
            lastVisitedAt,
          } satisfies BrowserHistoryEntryPayload;
        })
        .filter(
          (entry): entry is BrowserHistoryEntryPayload => Boolean(entry),
        );
    } finally {
      database.close();
    }
  } finally {
    await cleanup();
  }
}

export async function importChromiumFamilyCookiesIntoWorkspaceSession(
  browser: ChromiumFamilyBrowser,
  browserSession: Session,
  profileDir: string,
): Promise<BrowserCookieImportSummary> {
  const browserDisplayName = chromiumFamilyDisplayName(browser);
  const cookiesPath = chromeProfileCookiesPath(profileDir);
  if (!cookiesPath) {
    return {
      importedCount: 0,
      skippedCount: 0,
      warnings: [],
    };
  }

  if (process.platform !== "darwin" && process.platform !== "win32") {
    return {
      importedCount: 0,
      skippedCount: 0,
      warnings: [
        `Cookie import for ${browserDisplayName} is currently supported on macOS and Windows only. Bookmarks and history were still imported.`,
      ],
    };
  }

  let safeStoragePassword = "";
  let windowsEncryptionKey: Buffer | null = null;
  if (process.platform === "darwin") {
    try {
      safeStoragePassword = readChromeSafeStoragePasswordMac();
    } catch (error) {
      return {
        importedCount: 0,
        skippedCount: 0,
        warnings: [
          error instanceof Error
            ? error.message
            : `${browserDisplayName} cookie decryption key could not be loaded.`,
        ],
      };
    }
  } else if (process.platform === "win32") {
    try {
      const encryptedKey = readChromeWindowsEncryptedKey(path.dirname(profileDir));
      windowsEncryptionKey = decryptWindowsDpapi(encryptedKey);
    } catch (error) {
      return {
        importedCount: 0,
        skippedCount: 0,
        warnings: [
          error instanceof Error
            ? error.message
            : `${browserDisplayName} Windows cookie decryption key could not be loaded.`,
        ],
      };
    }
  }

  const { copiedPath, cleanup } = await copyChromeProfileDatabaseToTemp(
    cookiesPath,
    "holaboss-chrome-cookies-",
  );

  try {
    const database = new Database(copiedPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const rows = database
        .prepare(
          `
          SELECT
            host_key,
            name,
            value,
            path,
            CAST(expires_utc AS TEXT) AS expires_utc,
            is_secure,
            is_httponly,
            has_expires,
            is_persistent,
            samesite,
            encrypted_value
          FROM cookies
          ORDER BY host_key ASC, name ASC
        `,
        )
        .all() as Array<{
          host_key: string;
          name: string;
          value: string;
          path: string;
          expires_utc: string;
          is_secure: number;
          is_httponly: number;
          has_expires: number;
          is_persistent: number;
          samesite: number | null;
          encrypted_value: Buffer;
        }>;

      let importedCount = 0;
      let skippedCount = 0;
      const warnings = new Set<string>();
      const nowEpochSeconds = Date.now() / 1000;
      let expiredCount = 0;
      const transferableCookies: Array<{
        url: string;
        name: string;
        value: string;
        domain?: string;
        path: string;
        secure: boolean;
        httpOnly: boolean;
        sameSite: ReturnType<typeof chromeSameSiteToElectronSameSite>;
        expirationDate?: number;
      }> = [];

      for (const row of rows) {
        const cookieUrl = importedCookieUrl(
          row.host_key,
          row.path,
          Boolean(row.is_secure),
        );
        if (!cookieUrl || !row.name?.trim()) {
          skippedCount += 1;
          continue;
        }

        let cookieValue = row.value ?? "";
        if (!cookieValue) {
          try {
            const version = chromeEncryptedCookieVersion(row.encrypted_value);
            if (
              process.platform === "win32" &&
              version === CHROME_WINDOWS_APP_BOUND_COOKIE_PREFIX
            ) {
              throw new Error(
                "Some Windows Chrome cookies use App-Bound encryption and cannot be imported from a different desktop app.",
              );
            }
            const decryptedValue =
              process.platform === "win32"
                ? decryptChromeCookieValueWindows(
                    row.encrypted_value,
                    windowsEncryptionKey ?? Buffer.alloc(0),
                  )
                : decryptChromeCookieValueMac(
                    row.encrypted_value,
                    safeStoragePassword,
                  );
            cookieValue = decodeChromeCookieValue(
              row.host_key,
              decryptedValue,
            );
          } catch (error) {
            skippedCount += 1;
            warnings.add(
              error instanceof Error
                ? error.message
                : `Some ${browserDisplayName} cookies could not be decrypted.`,
            );
            continue;
          }
        }

        const expirationDate = chromeTimestampMicrosToIso(row.expires_utc);
        const expirationDateSeconds = expirationDate
          ? Math.floor(new Date(expirationDate).getTime() / 1000)
          : undefined;
        if (
          row.has_expires &&
          typeof expirationDateSeconds === "number" &&
          Number.isFinite(expirationDateSeconds) &&
          expirationDateSeconds <= nowEpochSeconds
        ) {
          skippedCount += 1;
          expiredCount += 1;
          continue;
        }

        transferableCookies.push({
          url: cookieUrl,
          name: row.name.trim(),
          value: cookieValue,
          domain: row.host_key?.trim() || undefined,
          path: row.path?.trim() || "/",
          secure: Boolean(row.is_secure),
          httpOnly: Boolean(row.is_httponly),
          sameSite: chromeSameSiteToElectronSameSite(row.samesite),
          expirationDate: row.has_expires ? expirationDateSeconds : undefined,
        });
      }

      if (expiredCount > 0) {
        warnings.add(
          `Skipped ${expiredCount} expired ${browserDisplayName} cookies.`,
        );
      }

      if (transferableCookies.length === 0) {
        return {
          importedCount: 0,
          skippedCount,
          warnings: Array.from(warnings),
        };
      }

      const stagedSession = session.fromPartition(
        `holaboss-browser-import-${randomUUID()}`,
      );
      const stagedCookies: typeof transferableCookies = [];
      try {
        await stagedSession.clearStorageData({ storages: ["cookies"] });
        for (const cookiePayload of transferableCookies) {
          try {
            await stagedSession.cookies.set(cookiePayload);
            stagedCookies.push(cookiePayload);
          } catch (error) {
            const normalizedDomain = cookiePayload.domain?.replace(/^\.+/, "");
            if (normalizedDomain && normalizedDomain !== cookiePayload.domain) {
              try {
                const normalizedPayload = {
                  ...cookiePayload,
                  domain: normalizedDomain,
                };
                await stagedSession.cookies.set(normalizedPayload);
                stagedCookies.push(normalizedPayload);
                continue;
              } catch {
                // Fall through to warning path below.
              }
            }
            skippedCount += 1;
            warnings.add(
              error instanceof Error
                ? error.message
                : `Some ${browserDisplayName} cookies could not be imported into Electron.`,
            );
          }
        }
        await stagedSession.cookies.flushStore();
        if (stagedCookies.length === 0) {
          return {
            importedCount: 0,
            skippedCount,
            warnings: Array.from(warnings),
          };
        }

        await browserSession.clearStorageData({ storages: ["cookies"] });
        for (const cookiePayload of stagedCookies) {
          try {
            await browserSession.cookies.set(cookiePayload);
            importedCount += 1;
          } catch (error) {
            skippedCount += 1;
            warnings.add(
              error instanceof Error
                ? error.message
                : `Some ${browserDisplayName} cookies could not be imported into Electron.`,
            );
          }
        }
      } finally {
        await stagedSession.clearStorageData({ storages: ["cookies"] });
      }

      await browserSession.cookies.flushStore();
      return {
        importedCount,
        skippedCount,
        warnings: Array.from(warnings),
      };
    } finally {
      database.close();
    }
  } finally {
    await cleanup();
  }
}

export async function importChromeCookiesIntoWorkspaceSession(
  browserSession: Session,
  profileDir: string,
): Promise<BrowserCookieImportSummary> {
  return importChromiumFamilyCookiesIntoWorkspaceSession(
    "chrome",
    browserSession,
    profileDir,
  );
}
