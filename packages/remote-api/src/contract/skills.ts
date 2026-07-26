import { oc } from "@orpc/contract";
import { z } from "zod";

const skillCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});

const catalogOutputSchema = z.object({
  skills: z.array(skillCatalogEntrySchema),
});

const installInputSchema = z.object({
  skillId: z.string().min(1),
  // Full SKILL.md body to materialize into the workspace. The caller resolves
  // this from the marketplace (via the directory gateway) — the runtime no
  // longer ships an embedded skill catalog to read bodies from.
  content: z.string().min(1),
});

export const skillsContract = {
  catalog: oc.input(z.object({})).output(catalogOutputSchema),
  install: oc
    .input(installInputSchema)
    .errors({ NOT_FOUND: { message: "skill not found" } })
    .output(skillCatalogEntrySchema),
};

export type SkillCatalogEntry = z.infer<typeof skillCatalogEntrySchema>;
