// Ambient fallback for the darwin-only native module `node-mac-permissions`.
// The package declares `os: ["darwin"]`, so bun/npm skip installing it on
// non-macOS CI — which breaks the desktop typecheck with TS2307 even though the
// import is only exercised on macOS at runtime. This shim lets the typecheck
// resolve the module everywhere; on macOS the real package (with the same
// public shape) is what's actually built and run.
declare module "node-mac-permissions" {
  export function askForScreenCaptureAccess(
    openPreferences?: boolean,
  ): undefined;
  export function getAuthStatus(authType: string): string;
}
