import type {
  ShareDraft,
  ShareDraftImage,
  ShareDraftItem,
  ShareDraftSessionTurn,
} from "@holaboss/app-host/protocol";
import { useCallback } from "react";
import { useOpenDiscover } from "./useOpenDiscover";

// Each share targets a unique compose path. The HolaHub surface is a kept-alive
// BrowserView; navigating to the SAME "/compose" is a no-op (the atom doesn't
// change and main's warm-reopen short-circuits), so a second share would never
// re-mount the compose gate. A per-share nonce forces a fresh navigation → the
// gate re-mounts and consumes the newly staged draft.
let shareNonce = 0;

/**
 * Share a desktop output (an assistant turn) to HolaHub: stage the draft with
 * main, then open the HolaHub composer (Discover surface) — it pulls the draft
 * via `holahub.consume-pending-share` and prefills. Attribution `items` are the
 * apps that actually produced this turn's outputs (resolved by the caller from
 * the outputs' module ids), so viewers can install what made the content.
 * Everything stays user-editable before posting.
 */
export function useShareToHolahub() {
  const openDiscover = useOpenDiscover();

  return useCallback(
    async (input: {
      title?: string;
      /** The user writes the caption in the composer — leave empty for a share
       *  that centers on the produced artifact. */
      body?: string;
      /** The turn's text, carried as hidden context for the AI caption draft. */
      sourceText?: string;
      imageIds?: string[];
      images?: ShareDraftImage[];
      videos?: ShareDraftImage[];
      items?: ShareDraftItem[];
      /** When set, share the whole conversation as a "session" post. */
      session?: { turns: ShareDraftSessionTurn[] };
    }) => {
      const body = input.body?.trim() ?? "";
      const images = input.images ?? [];
      const videos = input.videos ?? [];
      const sessionTurns = input.session?.turns ?? [];
      if (
        !(body || images.length > 0 || videos.length > 0 || sessionTurns.length > 0)
      ) {
        return;
      }
      const draft: ShareDraft = {
        title: input.title?.trim() ?? "",
        body,
        sourceText: input.sourceText?.trim() ?? "",
        imageIds: input.imageIds ?? [],
        images,
        videos,
        items: input.items ?? [],
        source: "desktop_chat",
        ...(sessionTurns.length > 0 ? { session: { turns: sessionTurns } } : {}),
      };
      try {
        await window.electronAPI.holahub.stageShare(draft);
        shareNonce += 1;
        openDiscover(`/compose?share=${shareNonce}`);
      } catch {
        // Not running inside the desktop host — no-op.
      }
    },
    [openDiscover]
  );
}
