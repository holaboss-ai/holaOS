import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "jotai";
import { publishSkillTitlesAtom, skillTitlesAtom } from "./skillTitles";

test("the workspace list does not drop a name an installer published first", () => {
  const store = createStore();
  store.set(publishSkillTitlesAtom, {
    "c_344210f3-1af6-480a-aef3-4f12c8564a21": "Steelman Both Sides",
  });
  store.set(publishSkillTitlesAtom, { summarizer: "Summarizer" });

  assert.deepEqual(store.get(skillTitlesAtom), {
    "c_344210f3-1af6-480a-aef3-4f12c8564a21": "Steelman Both Sides",
    summarizer: "Summarizer",
  });
});

test("a later title wins and an empty one is ignored", () => {
  const store = createStore();
  store.set(publishSkillTitlesAtom, { summarizer: "Summarizer" });
  store.set(publishSkillTitlesAtom, { summarizer: "" });
  assert.equal(store.get(skillTitlesAtom).summarizer, "Summarizer");

  store.set(publishSkillTitlesAtom, { summarizer: "Summarise" });
  assert.equal(store.get(skillTitlesAtom).summarizer, "Summarise");
});

test("republishing the same titles keeps the identity stable", () => {
  const store = createStore();
  store.set(publishSkillTitlesAtom, { summarizer: "Summarizer" });
  const first = store.get(skillTitlesAtom);
  store.set(publishSkillTitlesAtom, { summarizer: "Summarizer" });
  assert.equal(store.get(skillTitlesAtom), first);
});
