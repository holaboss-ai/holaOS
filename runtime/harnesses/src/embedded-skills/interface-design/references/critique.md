# Critique

Your first build shipped the structure. Now look at it the way a design lead reviews a junior's work — not asking "does this work?" but "would I put my name on this?"

---

## The Gap

There's a distance between correct and crafted. Correct means the layout holds, the grid aligns, the colors don't clash. Crafted means someone cared about every decision down to the last pixel. You can feel the difference immediately — the way you tell a hand-thrown mug from an injection-molded one. Both hold coffee. One has presence.

Your first output lives in correct. This command pulls it toward crafted.

---

## See the Composition

Step back. Look at the whole thing.

Does the layout have rhythm? Great interfaces breathe unevenly — dense tooling areas give way to open content, heavy elements balance against light ones, the eye travels through the page with purpose. Default layouts are monotone: same card size, same gaps, same density everywhere. Flatness is the sound of no one deciding.

Are proportions doing work? A 280px sidebar next to full-width content says "navigation serves content." A 360px sidebar says "these are peers." The specific number declares what matters. If you can't articulate what your proportions are saying, they're not saying anything.

Is there a clear focal point? Every screen has one thing the user came here to do. That thing should dominate — through size, position, contrast, or the space around it. When everything competes equally, nothing wins and the interface feels like a parking lot.

---

## See the Craft

Move close. Pixel-close.

The spacing grid is non-negotiable — every value a multiple of 4, no exceptions — but correctness alone isn't craft. Craft is knowing that a tool panel at 16px padding feels workbench-tight while the same card at 24px feels like a brochure. The same number can be right in one context and lazy in another. Density is a design decision, not a constant.

Typography should be legible even squinted. If size is the only thing separating your headline from your body from your label, the hierarchy is too weak. Weight, tracking, and opacity create layers that size alone can't.

Surfaces should whisper hierarchy. Not thick borders, not dramatic shadows — quiet tonal shifts where you feel the depth without seeing it. Remove every border from your CSS mentally. Can you still perceive the structure through surface color alone? If not, your surfaces aren't working hard enough.

Interactive elements need life. Every button, link, and clickable region should respond to hover and press. Not dramatically — a subtle shift in background, a gentle darkening. Missing states make an interface feel like a photograph of software instead of software.

---

## See the Content

Read every visible string as a user would. Not checking for typos — checking for truth.

Does this screen tell one coherent story? Could a real person at a real company be looking at exactly this data right now? Or does the page title belong to one product, the article body to another, and the sidebar metrics to a third?

Content incoherence breaks the illusion faster than any visual flaw. A beautifully designed interface with nonsensical content is a movie set with no script.

---

## See the Structure

Open the CSS and find the lies — the places that look right but are held together with tape.

Negative margins undoing a parent's padding. Calc() values that exist only as workarounds. Absolute positioning to escape layout flow. Each is a shortcut where a clean solution exists. Cards with full-width dividers use flex column and section-level padding. Centered content uses max-width with auto margins. The correct answer is always simpler than the hack.

---

## Again

Look at your output one final time.

Ask: "If they said this lacks craft, what would they point to?"

That thing you just thought of — fix it. Then ask again.

The first build was the draft. The critique is the design.
