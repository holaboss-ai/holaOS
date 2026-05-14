import test from "node:test";
import assert from "node:assert/strict";

import {
  HOLABOSS_HOME_URL,
  buildDesktopBillingLinks,
  deriveAppBaseUrl,
  normalizeBaseUrl,
} from "./billing-links.js";

test("deriveAppBaseUrl", async (t) => {
  await t.test(
    "given the holaos.ai prod API host, derives the www.holaos.ai web host",
    () => {
      assert.equal(
        deriveAppBaseUrl("https://api.holaos.ai"),
        "https://www.holaos.ai",
      );
    },
  );

  await t.test(
    "given the holaos.ai API host with a trailing path, still derives www.holaos.ai (path is dropped, origin only)",
    () => {
      assert.equal(
        deriveAppBaseUrl("https://api.holaos.ai/api/v1"),
        "https://www.holaos.ai",
      );
    },
  );

  await t.test(
    "given the holaboss.ai legacy prod API host, derives app.holaboss.ai",
    () => {
      assert.equal(
        deriveAppBaseUrl("https://api.holaboss.ai"),
        "https://app.holaboss.ai",
      );
    },
  );

  await t.test(
    "given the imerchstaging staging API host, derives app.imerchstaging.com",
    () => {
      assert.equal(
        deriveAppBaseUrl("https://api.imerchstaging.com"),
        "https://app.imerchstaging.com",
      );
    },
  );

  await t.test(
    "given the imerchstaging preview API host, derives preview.imerchstaging.com",
    () => {
      assert.equal(
        deriveAppBaseUrl("https://api-preview.imerchstaging.com"),
        "https://preview.imerchstaging.com",
      );
    },
  );

  await t.test(
    "given the local dev API host on port 4000, derives the web dev origin on port 4321",
    () => {
      assert.equal(
        deriveAppBaseUrl("http://localhost:4000"),
        "http://localhost:4321",
      );
    },
  );

  await t.test(
    "given localhost on a non-dev port, returns the same origin unchanged",
    () => {
      assert.equal(
        deriveAppBaseUrl("http://localhost:5173"),
        "http://localhost:5173",
      );
    },
  );

  await t.test(
    "given a host that doesn't match any known pattern, returns the origin unchanged",
    () => {
      assert.equal(
        deriveAppBaseUrl("https://example.com"),
        "https://example.com",
      );
    },
  );

  await t.test(
    "given an empty string, falls back to the holaboss home URL",
    () => {
      assert.equal(deriveAppBaseUrl(""), HOLABOSS_HOME_URL);
    },
  );

  await t.test(
    "given a malformed URL, falls back to the holaboss home URL",
    () => {
      assert.equal(deriveAppBaseUrl("not a url"), HOLABOSS_HOME_URL);
    },
  );
});

test("buildDesktopBillingLinks", async (t) => {
  await t.test(
    "given the www.holaos.ai web base, builds all four billing links rooted there",
    () => {
      const links = buildDesktopBillingLinks("https://www.holaos.ai");
      assert.deepEqual(links, {
        billingPageUrl: "https://www.holaos.ai/app/settings?tab=billing",
        addCreditsUrl:
          "https://www.holaos.ai/app/settings?tab=billing&intent=add-credits",
        upgradeUrl:
          "https://www.holaos.ai/app/settings?tab=billing&intent=upgrade",
        usageUrl: "https://www.holaos.ai/app/settings?tab=billing&intent=usage",
      });
    },
  );

  await t.test(
    "given a base URL with a trailing slash, normalizes it before composing the links",
    () => {
      const links = buildDesktopBillingLinks("https://app.imerchstaging.com/");
      assert.equal(
        links.billingPageUrl,
        "https://app.imerchstaging.com/app/settings?tab=billing",
      );
    },
  );

  await t.test(
    "given an empty base URL, falls back to the holaboss home URL",
    () => {
      const links = buildDesktopBillingLinks("");
      assert.equal(
        links.billingPageUrl,
        `${HOLABOSS_HOME_URL}/app/settings?tab=billing`,
      );
    },
  );
});

test("deriveAppBaseUrl piped into buildDesktopBillingLinks (the production code path)", async (t) => {
  await t.test(
    "given api.holaos.ai, the Manage button URL lands on www.holaos.ai (regression test for the app./www. mixup)",
    () => {
      const appBase = deriveAppBaseUrl("https://api.holaos.ai");
      const links = buildDesktopBillingLinks(appBase);
      assert.equal(
        links.billingPageUrl,
        "https://www.holaos.ai/app/settings?tab=billing",
      );
      assert.equal(
        links.addCreditsUrl,
        "https://www.holaos.ai/app/settings?tab=billing&intent=add-credits",
      );
    },
  );

  await t.test(
    "given api.imerchstaging.com, the Manage button URL lands on app.imerchstaging.com (staging is unchanged)",
    () => {
      const appBase = deriveAppBaseUrl("https://api.imerchstaging.com");
      const links = buildDesktopBillingLinks(appBase);
      assert.equal(
        links.billingPageUrl,
        "https://app.imerchstaging.com/app/settings?tab=billing",
      );
    },
  );

  await t.test(
    "given api-preview.imerchstaging.com, the Manage button URL lands on preview.imerchstaging.com",
    () => {
      const appBase = deriveAppBaseUrl(
        "https://api-preview.imerchstaging.com",
      );
      const links = buildDesktopBillingLinks(appBase);
      assert.equal(
        links.billingPageUrl,
        "https://preview.imerchstaging.com/app/settings?tab=billing",
      );
    },
  );
});

test("normalizeBaseUrl", async (t) => {
  await t.test("strips a single trailing slash", () => {
    assert.equal(normalizeBaseUrl("https://www.holaos.ai/"), "https://www.holaos.ai");
  });

  await t.test("strips multiple trailing slashes", () => {
    assert.equal(
      normalizeBaseUrl("https://www.holaos.ai///"),
      "https://www.holaos.ai",
    );
  });

  await t.test("returns an empty string for null or undefined input", () => {
    assert.equal(normalizeBaseUrl(null), "");
    assert.equal(normalizeBaseUrl(undefined), "");
  });
});
