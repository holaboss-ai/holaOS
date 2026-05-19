import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BILLING_SUMMARY_CARD_PATH = new URL(
  "./BillingSummaryCard.tsx",
  import.meta.url,
);

test("billing summary card adds a credits help popover next to the credits label", async () => {
  const source = await readFile(BILLING_SUMMARY_CARD_PATH, "utf8");

  assert.match(source, /Popover/);
  assert.match(source, /PopoverTrigger/);
  assert.match(source, /PopoverContent/);
  assert.match(source, /About credits/);
  assert.match(
    source,
    /Your available balance reflects all non-expired credit allocations minus usage\./,
  );
  assert.match(
    source,
    /Monthly credits come from your subscription and expire at the end of the current billing period\./,
  );
  assert.match(
    source,
    /Purchased credits and signup bonus credits do not expire\./,
  );
  assert.doesNotMatch(source, /event credits/);
  assert.doesNotMatch(source, /daily credits/);
});
