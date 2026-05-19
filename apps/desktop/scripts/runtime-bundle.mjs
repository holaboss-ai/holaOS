import path from "node:path";

const RUNTIME_PLATFORM_MAP = new Map([
  ["darwin", "macos"],
  ["linux", "linux"],
  ["macos", "macos"],
  ["win32", "windows"],
  ["windows", "windows"]
]);

export function resolveRuntimePlatform(options = {}) {
  const explicitValue = options.explicitPlatform ?? process.env.HOLABOSS_RUNTIME_PLATFORM ?? "";
  const explicitPlatform = String(explicitValue).trim().toLowerCase();
  if (explicitPlatform) {
    const resolved = RUNTIME_PLATFORM_MAP.get(explicitPlatform);
    if (!resolved) {
      throw new Error(`Unsupported runtime platform: ${explicitPlatform}`);
    }
    return resolved;
  }

  const hostValue = options.hostPlatform ?? process.platform;
  const hostPlatform = String(hostValue).trim().toLowerCase();
  const resolved = RUNTIME_PLATFORM_MAP.get(hostPlatform);
  if (!resolved) {
    throw new Error(`Unsupported host platform: ${hostPlatform}`);
  }
  return resolved;
}

export function runtimeBundleDirName(runtimePlatform = resolveRuntimePlatform()) {
  return `runtime-${runtimePlatform}`;
}

export function runtimeBundleExecutableRelativePaths(runtimePlatform = resolveRuntimePlatform()) {
  const base = path.join("bin", "sandbox-runtime");
  return runtimePlatform === "windows"
    ? [`${base}.mjs`, `${base}.cmd`, `${base}.ps1`, `${base}.exe`, base]
    : [base];
}

export function runtimeBundleNodeRelativePaths(runtimePlatform = resolveRuntimePlatform()) {
  const base = path.join("node-runtime", "node_modules", ".bin", "node");
  const packagedBin =
    runtimePlatform === "windows"
      ? path.join("node-runtime", "bin", "node.exe")
      : path.join("node-runtime", "node_modules", "node", "bin", "node");
  return runtimePlatform === "windows"
    ? [
        packagedBin,
        `${base}.exe`,
        `${base}.cmd`,
        base
      ]
    : [packagedBin, base];
}

export function runtimeBundleNpmRelativePaths(runtimePlatform = resolveRuntimePlatform()) {
  const base = path.join("node-runtime", "node_modules", ".bin", "npm");
  return runtimePlatform === "windows"
    ? [
        path.join("node-runtime", "bin", "npm.cmd"),
        path.join("node-runtime", "bin", "npm"),
        `${base}.cmd`,
        base,
        path.join("node-runtime", "node_modules", "npm", "bin", "npm-cli.js")
      ]
    : [
        base,
        path.join("node-runtime", "node_modules", "npm", "bin", "npm-cli.js")
      ];
}

export function runtimeBundlePythonRelativePaths(runtimePlatform = resolveRuntimePlatform()) {
  const base = path.join("python-runtime", "bin", "python");
  return runtimePlatform === "windows"
    ? [
        `${base}.cmd`,
        path.join("python-runtime", "python", "python.exe"),
        path.join("python-runtime", "python", "python3.exe")
      ]
    : [base];
}

export function runtimeBundleRequiredPathGroups(runtimePlatform = resolveRuntimePlatform()) {
  return [
    runtimeBundleExecutableRelativePaths(runtimePlatform),
    ["package-metadata.json"],
    runtimeBundleNodeRelativePaths(runtimePlatform),
    runtimeBundleNpmRelativePaths(runtimePlatform),
    runtimeBundlePythonRelativePaths(runtimePlatform),
    [path.join("runtime", "metadata.json")],
    [path.join("runtime", "api-server", "dist", "index.mjs")]
  ];
}

export function localRuntimePackagerFileNames(runtimePlatform = resolveRuntimePlatform()) {
  const base = `package_${runtimePlatform}_runtime`;
  return runtimePlatform === "windows"
    ? [`${base}.mjs`, `${base}.sh`]
    : [`${base}.sh`, `${base}.mjs`];
}
