import { oc } from "@orpc/contract";
import { z } from "zod";
import { workspaceScoped } from "./shared";

const capabilitySkillRefSchema = z.union([
  z.object({ path: z.string() }),
  z.object({ ref: z.string() }),
]);

const capabilityIntegrationRequirementSchema = z.object({
  provider: z.string(),
  required: z.boolean(),
  reason: z.string().optional(),
});

export const capabilityCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string().optional(),
  icon: z.string().optional(),
  skills: z.array(capabilitySkillRefSchema),
  integrations: z.array(capabilityIntegrationRequirementSchema),
});

export const workspaceCapabilitySchema = z.object({
  workspaceId: z.string(),
  capabilityId: z.string(),
  version: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  status: z.string(),
  installedSkillIds: z.array(z.string()),
  integrationStatus: z.record(z.string(), z.string()),
  config: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const catalogOutputSchema = z.object({
  capabilities: z.array(capabilityCatalogEntrySchema),
});

const listInstalledOutputSchema = z.object({
  capabilities: z.array(workspaceCapabilitySchema),
});

const installInputSchema = workspaceScoped.extend({
  capabilityId: z.string().min(1),
});

const uninstallOutputSchema = z.object({
  removed: z.boolean(),
});

const toggleInputSchema = workspaceScoped.extend({
  capabilityId: z.string().min(1),
  enabled: z.boolean(),
});

const createInputSchema = workspaceScoped.extend({
  name: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  skillIds: z.array(z.string()),
  integrationProviders: z.array(z.string()),
  // Keyless MCP servers to attach on install (resolved from the catalog by the
  // caller). Each becomes a remote server in the capability's workspace.yaml
  // registry. Keyed MCPs are gated in the UI and not passed here.
  mcps: z
    .array(
      z.object({
        id: z.string(),
        url: z.string(),
        tools: z.array(z.string()),
      })
    )
    .optional()
    .default([]),
});

const importPluginInputSchema = workspaceScoped.extend({
  pluginPath: z.string().min(1),
});

export const capabilitiesContract = {
  catalog: oc.input(z.object({})).output(catalogOutputSchema),
  listInstalled: oc.input(workspaceScoped).output(listInstalledOutputSchema),
  install: oc
    .input(installInputSchema)
    .errors({ NOT_FOUND: { message: "capability not found" } })
    .output(workspaceCapabilitySchema),
  create: oc.input(createInputSchema).output(workspaceCapabilitySchema),
  importPlugin: oc
    .input(importPluginInputSchema)
    .errors({ BAD_REQUEST: { message: "could not import plugin" } })
    .output(workspaceCapabilitySchema),
  uninstall: oc.input(installInputSchema).output(uninstallOutputSchema),
  toggle: oc
    .input(toggleInputSchema)
    .errors({ NOT_FOUND: { message: "capability not found" } })
    .output(workspaceCapabilitySchema),
};

export type CapabilityCatalogEntry = z.infer<typeof capabilityCatalogEntrySchema>;
export type WorkspaceCapability = z.infer<typeof workspaceCapabilitySchema>;
