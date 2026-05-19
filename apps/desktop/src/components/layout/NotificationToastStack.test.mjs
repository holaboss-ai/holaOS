import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const NOTIFICATION_TOAST_STACK_PATH = new URL(
  "./NotificationToastStack.tsx",
  import.meta.url,
);

test("notification toast stack anchors itself to the top right corner", async () => {
  const source = await readFile(NOTIFICATION_TOAST_STACK_PATH, "utf8");

  assert.match(
    source,
    /pointer-events-none fixed right-4 top-4 z-\[90\] flex w-\[min\(320px,calc\(100vw-2rem\)\)\] flex-col gap-3 sm:right-6 sm:top-6/,
  );
  assert.doesNotMatch(source, /fixed bottom-4 left-4/);
});

test("notification toast stack collapses by default and expands on hover or focus", async () => {
  const source = await readFile(NOTIFICATION_TOAST_STACK_PATH, "utf8");

  assert.match(source, /const \[isExpanded, setIsExpanded\] = useState\(false\);/);
  assert.match(source, /const COLLAPSED_TOAST_OFFSET_PX = 4;/);
  assert.match(source, /const COLLAPSED_TOAST_MAX_HEIGHT_PX = 76;/);
  assert.match(source, /const COLLAPSED_TOAST_PEEK_PX = 10;/);
  assert.match(source, /const EXPANDED_TOAST_GAP_PX = 12;/);
  assert.match(source, /function toastCardStyle\(/);
  assert.match(source, /const collapsedScale = Math\.max\(0\.97, 1 - index \* 0\.01\);/);
  assert.match(source, /return <CircleCheck size=\{16\} \/>;/);
  assert.match(source, /aria-expanded=\{isExpanded\}/);
  assert.match(source, /onMouseEnter=\{\(\) => setIsExpanded\(true\)\}/);
  assert.match(source, /onMouseLeave=\{\(\) => setIsExpanded\(false\)\}/);
  assert.match(source, /onFocusCapture=\{\(\) => setIsExpanded\(true\)\}/);
  assert.match(source, /transition-\[margin,transform,opacity,max-height\] duration-200 ease-out/);
  assert.match(source, /style=\{toastCardStyle\(index, notifications\.length, isExpanded\)\}/);
  assert.match(source, /maxHeight:\s*isExpanded \|\| index === 0 \? "320px" : `\$\{COLLAPSED_TOAST_MAX_HEIGHT_PX\}px`,/);
  assert.match(source, /const isCollapsedBackgroundToast = !isExpanded && index > 0;/);
  assert.match(source, /isCollapsedBackgroundToast\s*\?\s*"pointer-events-none shadow-lg"\s*:\s*"shadow-2xl"/);
  assert.match(source, /className="text-\[15px\] font-semibold leading-tight text-foreground"/);
  assert.match(source, /className="mt-1 text-\[13px\] leading-\[1\.2rem\] text-foreground\/85"/);
  assert.match(source, /className="flex items-start gap-2\.5 p-3\.5"/);
  assert.match(source, /"mt-0\.5 flex size-9 shrink-0 items-center justify-center rounded-xl ring-1"/);
  assert.match(source, /aria-hidden="true"/);
  assert.match(source, /<div aria-hidden="true" className="h-\[76px\]" \/>/);
  assert.doesNotMatch(source, /className="flex h-\[76px\] items-center gap-2\.5 px-4"/);
  assert.doesNotMatch(source, /<div className="h-2 w-18 rounded-full bg-foreground\/8" \/>/);
  assert.doesNotMatch(source, /function toastTimeLabel\(/);
  assert.doesNotMatch(source, /function priorityBadgeClassName\(/);
  assert.doesNotMatch(source, /function priorityLabel\(/);
});
