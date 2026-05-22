import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const signInScreenPath = path.join(__dirname, "SignInScreen.tsx");
const welcomeArtPath = path.join(__dirname, "WelcomeArt.tsx");

test("SignInScreen calls requestAuth from useDesktopAuthSession", async () => {
  const source = await readFile(signInScreenPath, "utf8");

  assert.match(source, /import \{ useDesktopAuthSession \} from "@\/lib\/auth\/authClient";/);
  assert.match(source, /const \{ error, isPending, requestAuth \} = useDesktopAuthSession\(\);/);
  assert.match(source, /await requestAuth\(\);/);
});

test("SignInScreen surfaces error and pending states", async () => {
  const source = await readFile(signInScreenPath, "utf8");

  // Local pending until the gate flips on data.
  assert.match(source, /const \[isStarting, setIsStarting\] = useState\(false\);/);
  assert.match(source, /Waiting for sign-in…/);

  // Error banner uses the project's destructive convention.
  assert.match(source, /rounded-lg bg-destructive\/8 px-3 py-2\.5 text-sm text-destructive/);

  // Browser-opened hint with retry CTA.
  assert.match(source, /BROWSER_SIGN_IN_HINT/);
  assert.match(source, /Didn't open\? Open the browser again/);
});

test("SignInScreen mirrors welcome-step DNA: WelcomeHero + staggered FeatureCards", async () => {
  const source = await readFile(signInScreenPath, "utf8");

  assert.match(
    source,
    /import \{ FeatureCard, WelcomeHero \} from "@\/components\/auth\/WelcomeArt";/,
  );
  assert.match(source, /<WelcomeHero \/>/);
  assert.match(source, /<FeatureCard[\s\S]*art=\{<Sparkles strokeWidth=\{1\.25\} \/>\}[\s\S]*delayMs=\{120\}/);
  assert.match(source, /<FeatureCard[\s\S]*art=\{<Plug strokeWidth=\{1\.25\} \/>\}[\s\S]*delayMs=\{220\}/);
  assert.match(source, /<FeatureCard[\s\S]*art=\{<Zap strokeWidth=\{1\.25\} \/>\}[\s\S]*delayMs=\{320\}/);
  assert.match(source, /grid grid-cols-3 gap-3/);

  // Card lives inside OnboardingShell to keep the brand bar + canvas.
  assert.match(
    source,
    /import \{ OnboardingShell \} from "@\/components\/onboarding\/OnboardingShell";/,
  );
  assert.match(source, /rounded-2xl bg-background px-8 pt-9 pb-8 shadow-xs sm:px-10 sm:pt-10 sm:pb-9/);
  // Viewport-pinning wrapper — OnboardingShell relies on flex-1, so it needs a
  // parent that fills the window or it collapses to content height.
  assert.match(source, /<div className="fixed inset-0 z-30 flex min-h-0 flex-col">/);
});

test("WelcomeArt exports the brand hero and feature card", async () => {
  const source = await readFile(welcomeArtPath, "utf8");

  assert.match(source, /export function WelcomeHero\(\)/);
  assert.match(source, /export function FeatureCard\(/);
  // Three static halo rings fading outward.
  assert.match(source, /border-primary\/8/);
  assert.match(source, /border-primary\/16/);
  assert.match(source, /border-primary\/26/);
  assert.doesNotMatch(source, /holaboss-splash-halo/);
});
