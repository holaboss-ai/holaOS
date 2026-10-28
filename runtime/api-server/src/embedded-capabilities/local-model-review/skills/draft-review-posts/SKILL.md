---
name: draft-review-posts
description: Draft social posts and vendor feedback from a local model eval's conclusion pack, and publish only after the user approves the exact content.
---

# Draft Review Posts

Use this after `write-conclusion-pack` has written `report.md` in a run directory.

## What makes these posts work

The posts people share about local models answer "does this run on hardware like mine, and is it good enough to use". They lead with the machine, the model, the engine and quantization, and a concrete number; they show the recipe; and the ones that last are honest about limits. A surprising result on ordinary hardware travels further than a big number on expensive hardware.

Write in the user's own voice; read a few of their past posts first if an X account is connected. Plain sentences, no hype words, no emoji walls.

## Drafts to produce

Save each to `<run_dir>/posts/` and show them in the chat:

1. **X post**: one post under 280 characters plus the speed chart. Machine, model, quantization, engine, the headline number, one surprising finding.
2. **X thread** (4 to 6 posts): the recipe (exact command or settings), the capability results with sample counts, the caveats worth knowing, the limitations, and a line for a link to the full report.
3. **Chinese short post** (for Xiaohongshu, Jike or similar): the same facts in natural Chinese, with the chart.
4. **Vendor feedback** (`vendor-feedback.md`, never published): what is worth promoting, what to fix with the evidence, and the follow-up experiments that confirmed it.

Every number in a draft must appear in `report.md`. Do not add links you do not have; leave a placeholder.

## Disclosure

If the review is paid or done in partnership with the model's vendor, the post must say so (`#ad`, "Sponsored", or "合作"). If you do not know, ask the user before drafting.

## Publishing

Posting goes through the user's connected accounts (X, LinkedIn, Reddit). holaOS blocks posting tools until the user approves the exact text, so:

1. Show the final text and attached image, and ask for approval with `ask_user_question`.
2. Publish exactly the approved content. If the user edits it, show the new version and ask again.

For platforms without a connected integration (for example Xiaohongshu), give the user the text and the image files to post themselves.
