import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const INDEX_PATH = fileURLToPath(new URL("./index.tsx", import.meta.url));

/**
 * Slice a single function so the assertions below cannot be satisfied by an
 * unrelated line elsewhere in a 10k-line file. A guard written as an unbounded
 * `[\s\S]*?` match over the whole source passes on a dead code path — that was
 * demonstrated against an earlier guard in this repo.
 */
async function functionBody(name) {
  const lines = (await readFile(INDEX_PATH, "utf8")).split("\n");
  const signature = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function ${name}\\b`);
  const start = lines.findIndex((line) => signature.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^(?:export\s+)?(?:async\s+)?function [\w$]+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * A wallet block is a condition of the ACCOUNT, not of the model that happened
 * to be running, so it must not be labelled with one.
 *
 * Two things break when it is. "Anthropic claude-sonnet-4: You're out of
 * credits…" reads as a fault of that model, so the user's next move is to switch
 * models — which cannot work. And the caller truncates at 120 characters, so a
 * long provider/model prefix pushes the instruction ("Top up…") past the cut,
 * leaving a message that states a problem and withholds the remedy.
 *
 * Pinned as ORDER rather than as an exact string: the early return has to happen
 * before the label is applied, however that label is later computed.
 */
test("a wallet block is returned before any provider/model label is applied", async () => {
  const body = await functionBody("runFailedDetail");
  assert.ok(body, "runFailedDetail not found — did the signature change?");

  const walletReturn = body.indexOf("return walletBlock;");
  const labelUse = body.indexOf("runFailedContextLabel(");
  assert.notEqual(walletReturn, -1, "runFailedDetail must early-return the wallet block");
  assert.notEqual(labelUse, -1, "runFailedDetail should still label non-wallet failures");
  assert.ok(
    walletReturn < labelUse,
    "the wallet block must be returned BEFORE runFailedContextLabel is applied",
  );
});
