import { benchRouter } from "./bench";
import { capabilitiesRouter } from "./capabilities";
import { os } from "./base";
import { channelsRouter } from "./channels";
import { cronjobsRouter } from "./cronjobs";
import { evalsRouter } from "./evals";
import { memoryRouter } from "./memory";
import { notificationsRouter } from "./notifications";
import { outputsRouter } from "./outputs";
import { skillsRouter } from "./skills";

export const remoteApiRouter = os.router({
  memory: memoryRouter,
  outputs: outputsRouter,
  notifications: notificationsRouter,
  cronjobs: cronjobsRouter,
  capabilities: capabilitiesRouter,
  skills: skillsRouter,
  channels: channelsRouter,
  evals: evalsRouter,
  bench: benchRouter,
});

export type RemoteApiRouter = typeof remoteApiRouter;
