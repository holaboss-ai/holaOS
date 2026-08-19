import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * A session must be listable the moment it is created.
 *
 * The sidebar hides titleless sessions as empty placeholders, and the title was
 * written only by the queue-input route — so the row appeared not when the
 * session was created but whenever the send finished assembling and queueing,
 * seconds later. Measured in the running app: the reload right after creation
 * came back `5630b58c:null`, and only the reload after the queue call returned
 * `5630b58c:"hey"`, which is exactly when the row showed up.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const chatPane = readFileSync(path.join(here, "index.tsx"), "utf-8");

test("the send passes its first message when creating the session", () => {
  assert.match(
    chatPane,
    /first_user_text: firstUserText\?\.trim\(\) \|\| null,/,
    "createWorkspaceSession must forward the text so the runtime can title the session",
  );
  assert.match(
    chatPane,
    /createWorkspaceSession\(\s*selectedWorkspace\.id,\s*draftParentSessionId,\s*selectedChatProjectId,\s*owningAppId,\s*text,\s*\)/,
    "the send path must pass the composer text",
  );
});

test("the title is derived by the runtime, not the client", () => {
  // sessionTitleFromFirstUserInput handles attachments and image-only sends as
  // well as text. Duplicating that here would drift, and because the queue
  // route leaves an existing title alone, any drift would be permanent.
  assert.doesNotMatch(
    chatPane,
    /sessionTitleFromFirstUserInput|normalizedSessionTitleSnippet/,
    "the client must not derive session titles itself",
  );
});
