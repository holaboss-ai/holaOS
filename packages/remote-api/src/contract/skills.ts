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

// A skill the user uploaded from their machine: a bare SKILL.md, or a .zip /
// .skill holding the folder (SKILL.md at the root, or one top-level folder).
// Base64 because the transport is JSON — see MAX_UPLOAD_BYTES for the ceiling.
const importUploadInputSchema = z.object({
  fileName: z.string().min(1),
  dataBase64: z.string().min(1),
});

const importUploadOutputSchema = skillCatalogEntrySchema.extend({
  grantedTools: z.array(z.string()),
  files: z.array(z.string()),
  replaced: z.boolean(),
});

export const skillsContract = {
  catalog: oc.input(z.object({})).output(catalogOutputSchema),
  install: oc
    .input(installInputSchema)
    .errors({ NOT_FOUND: { message: "skill not found" } })
    .output(skillCatalogEntrySchema),
  importUpload: oc
    .input(importUploadInputSchema)
    .errors({ BAD_REQUEST: { message: "invalid skill upload" } })
    .output(importUploadOutputSchema),
};

export type SkillCatalogEntry = z.infer<typeof skillCatalogEntrySchema>;
