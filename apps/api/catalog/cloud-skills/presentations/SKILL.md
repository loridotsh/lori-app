---
name: presentations
description: Create and revise slide decks with a clear story, one idea per slide, native charts and tables, and a flat, designed look.
---

# Presentations (PowerPoint)

Use for PPTX creation and revision. When the member wants a deck to view or present inside Lori rather than a PowerPoint file, save a `slides` artifact (`<name>.lori.json`, see the present_visual catalog) instead: it opens in the workspace with a slide rail and Present mode, and needs no sandbox command. In Cloud Work there are no "jobs" and no publish step: you build files with `run_command` in a private offline sandbox, the member approves the command and then the generated files, and `render_document` lets you look at the slides.

**Before authoring, load `references/creation.md` (the build recipe) and skim `references/design-principles.md`.** Load `references/verification.md` before you start checking.

## How to work
1. Decide the audience, the decision or message, and the length (a typical update is 6 to 10 slides). Draft the story as a list of slide headlines that read as a summary on their own.
2. Build the whole deck with the `lori_design` kit in **one** `run_command` (`from lori_design.pptx_kit import Deck`). It gives 16:9 slides with real title placeholders, native editable charts and tables, speaker notes, slide numbers, and text that is measured to fit.
3. Read `deck.warnings` after building: any text that cannot fit is reported there. Fix the content (shorter headline, fewer points, split the slide); do not shrink text below the kit's limits.
4. After the member applies the file: `validate_document`, then `render_document` (up to 6 slides per call) and look at every slide. Fix and rebuild until clean.
5. Reply with the story in one or two sentences, the slide count, assumptions and caveats.

## Rules that matter
- One idea per slide. A headline that states the finding ("AMER leads on sales while APAC sells the most units"), not a topic ("Sales"). At most about six short bullets or about 40 words of body text.
- Use the right shape for the content: numbers that matter become KPIs; comparisons become a chart; exact values become a table; ideas become bullets; contrasts become two columns. Charts are native (editable in PowerPoint), never pictures of charts.
- Flat and quiet: one accent colour, Arial, generous white space, no shadows, gradients, clip art or emoji, no decorative boxes around everything, no footers or kickers that repeat what the slide already says.
- Text must be readable from the back of a room: 14 pt minimum, headlines 22 to 30 pt.
- Put the source or caveat in one small line (`caption=`), not scattered fragments.
- Each command starts in an empty sandbox. List every existing file it reads in `inputPaths`; a file a command creates exists only after the member applies it. Images the deck uses must be in the workspace and listed.
- Only the working directory and `$TMPDIR` are writable. `/tmp` and other absolute paths are read-only: use relative paths for output and `$TMPDIR` for scratch files.
- A supplied template or the member's instructions beat these defaults; follow the template's layouts and fonts and edit it (`references/editing.md`).
- Do not search for or invent a "document job", `begin_document_job`, `publish_document` or `jobId`: they do not exist here.
- Never invent facts, logos, quotes or data presented as real. Label illustrative data on the slide.

## References
- `references/creation.md` - the kit and a full deck recipe.
- `references/editing.md` - changing an existing deck.
- `references/design-principles.md` - what good looks like.
- `references/verification.md` - the build, validate, render, fix loop and a defect checklist.

Load a reference with `load_skill` using the exact name listed. Omit `reference` to load this guide.
