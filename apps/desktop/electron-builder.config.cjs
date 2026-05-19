const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function resolveRuntimePlatform() {
  const explicitPlatform = (process.env.HOLABOSS_RUNTIME_PLATFORM || "").trim().toLowerCase();
  if (explicitPlatform) {
    switch (explicitPlatform) {
      case "macos":
      case "linux":
      case "windows":
        return explicitPlatform;
      default:
        throw new Error(`Unsupported HOLABOSS_RUNTIME_PLATFORM: ${explicitPlatform}`);
    }
  }

  switch (process.platform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      throw new Error(`Unsupported host platform: ${process.platform}`);
  }
}

const runtimePlatform = resolveRuntimePlatform();
const runtimeBundleDir = `runtime-${runtimePlatform}`;
const runtimeBundlePath = path.join(__dirname, "out", runtimeBundleDir);
const githubReleasesOwner = "holaboss-ai";
const githubReleasesRepo = "holaOS-releases";

function readEnv(name) {
  return (process.env[name] || "").trim();
}

const windowsCertificateSigningConfigured = Boolean(
  readEnv("WIN_CSC_LINK") || readEnv("CSC_LINK"),
);
const windowsAzureSigningEnv = {
  publisherName: "WINDOWS_SIGNING_PUBLISHER_NAME",
  endpoint: "WINDOWS_SIGNING_ENDPOINT",
  certificateProfileName: "WINDOWS_SIGNING_CERTIFICATE_PROFILE_NAME",
  codeSigningAccountName: "WINDOWS_SIGNING_ACCOUNT_NAME"
};
const windowsAzureSigningConfig = Object.fromEntries(
  Object.entries(windowsAzureSigningEnv).map(([key, envName]) => [
    key,
    readEnv(envName)
  ])
);
const windowsAzureSigningConfigured = Object.values(
  windowsAzureSigningConfig
).some(Boolean);
const missingWindowsAzureSigningEnv = Object.entries(windowsAzureSigningConfig)
  .filter(([, value]) => !value)
  .map(([key]) => windowsAzureSigningEnv[key]);

if (windowsAzureSigningConfigured && missingWindowsAzureSigningEnv.length > 0) {
  throw new Error(
    `Incomplete Windows Azure Trusted Signing configuration. Missing: ${missingWindowsAzureSigningEnv.join(", ")}`
  );
}

if (windowsAzureSigningConfigured && windowsCertificateSigningConfigured) {
  throw new Error(
    "Configure either Azure Trusted Signing or CSC_LINK/WIN_CSC_LINK Windows certificate signing, not both."
  );
}

const windowsSigningConfigured =
  windowsAzureSigningConfigured || windowsCertificateSigningConfigured;
const configuredReleaseChannel = (
  process.env.HOLABOSS_RELEASE_CHANNEL || ""
).trim().toLowerCase();

function resolveReleaseChannel() {
  if (!configuredReleaseChannel || configuredReleaseChannel === "latest") {
    return "latest";
  }
  if (configuredReleaseChannel === "beta") {
    return "beta";
  }
  throw new Error(
    `Unsupported HOLABOSS_RELEASE_CHANNEL: ${configuredReleaseChannel}`,
  );
}

const releaseChannel = resolveReleaseChannel();
const macIdentity = (process.env.HOLABOSS_MAC_IDENTITY || "").trim();
const extraResources = [
  {
    from: "resources/icon.png",
    to: "icon.png"
  },
  {
    from: "resources/holaStatusTemplate.png",
    to: "holaStatusTemplate.png"
  },
  {
    from: "resources/holaStatusTemplate@2x.png",
    to: "holaStatusTemplate@2x.png"
  },
  {
    from: "out/holaboss-config.json",
    to: "holaboss-config.json"
  },
  {
    from: runtimeBundlePath,
    to: runtimeBundleDir,
    filter: [
      "bin/**/*",
      "node-runtime/**/*",
      "package-metadata.json",
      "python-runtime/**/*",
      "runtime/**/*"
    ]
  }
];

module.exports = {
  appId: "com.holaboss.workspace",
  productName: "holaOS",
  generateUpdatesFilesForAllChannels: true,
  directories: {
    output: "out/release"
  },
  files: [
    "out/dist/**/*",
    "out/dist-electron/**/*",
    "package.json"
  ],
  extraResources,
  asar: true,
  protocols: [
    {
      name: "holaOS Auth Callback",
      schemes: [
        "ai.holaboss.app"
      ]
    }
  ],
  icon: "resources/icon.png",
  mac: {
    icon: "resources/icon.icns",
    category: "public.app-category.developer-tools",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.mac.plist",
    entitlementsInherit: "resources/entitlements.mac.plist",
    // identity:null in electron-builder means "skip signing" — only set the key when an explicit value is provided.
    ...(macIdentity ? { identity: macIdentity } : {})
  },
  publish: [
    {
      provider: "github",
      owner: githubReleasesOwner,
      repo: githubReleasesRepo,
      ...(releaseChannel === "beta" ? { channel: releaseChannel } : {})
    }
  ],
  win: {
    icon: "resources/icon.ico",
    signAndEditExecutable: windowsSigningConfigured,
    ...(windowsAzureSigningConfigured
      ? {
          azureSignOptions: windowsAzureSigningConfig
        }
      : {}),
    target: [
      {
        target: "nsis",
        arch: [
          "x64"
        ]
      }
    ]
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true
  },
  beforePack: async () => {
    if (!fs.existsSync(runtimeBundlePath)) {
      throw new Error(
        `Missing staged runtime bundle at ${runtimeBundlePath}. Run the matching prepare:runtime command before packaging.`
      );
    }
  },
  afterPack: async (context) => {
    if (context.electronPlatformName !== "darwin") {
      return;
    }
    const { writeAppUpdateConfig } = await import(
      pathToFileURL(
        path.join(__dirname, "scripts", "write-app-update-config.mjs")
      ).href
    );
    const appBundlePath = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`
    );
    await writeAppUpdateConfig(appBundlePath);
  }
};
