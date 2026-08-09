import { atom } from "jotai";

/**
 * Live `skillId → display title`, published by ChatPane from the workspace's
 * skill list and by the installers from the catalog entry they just added.
 *
 * A skill chip stores its title in the document node, resolved once when the
 * document is built. Seed a composer in the same breath as an install — which is
 * exactly what "install, then open a chat with it quoted" does — and the skill
 * list has not arrived yet, so the raw id gets written into the node and stays
 * there: `c_f209f381-267e-49e8-8673-64a7ebf8cdc2`. Reading through this atom
 * lets the chip heal once the list lands, and follow a rename after that.
 */
export const skillTitlesAtom = atom<Record<string, string>>({});

/**
 * Merge titles in rather than replace the map: an installer knows a community
 * skill's name before its folder exists, and the workspace list — which arrives
 * later and only covers what is on disk — must not drop that name on the floor.
 */
export const publishSkillTitlesAtom = atom(
  null,
  (get, set, titles: Record<string, string>) => {
    const current = get(skillTitlesAtom);
    let changed = false;
    const next = { ...current };
    for (const [skillId, title] of Object.entries(titles)) {
      if (title && next[skillId] !== title) {
        next[skillId] = title;
        changed = true;
      }
    }
    if (changed) {
      set(skillTitlesAtom, next);
    }
  },
);
