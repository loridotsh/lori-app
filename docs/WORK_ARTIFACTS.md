# Inline visuals in chat

Lori renders structured visuals directly in the assistant response, between the
surrounding Markdown sections. There is no separate artifact workspace, creation
form, output selector, artifact-management card, or Artifacts count. Diagram previews can be clicked
to inspect the same diagram in a larger viewer. Ordinary files
retain their existing right-side preview/editor and document lifecycle.

## User experience

Ask naturally in chat. Diagrams explain processes or relationships; charts compare
actual values; calculators explore assumptions; steps explain a sequence; quizzes
and flashcards support a requested learning task. Ordinary prose, lists, code and
small tables stay Markdown. Existing saved `present_visual` results remain usable.

The response keeps chronological text/visual/tool boundaries. Visuals render as
quiet inline sections with restrained separators, a readable title and summary,
local controls, source notes, copy, and optional data download. Follow-up changes
are requested in the normal composer. Successful earlier outputs remain in history.
No source files or old messages are rewritten by this UI change.

## Safety and lifecycle

- Both server admission and UI rendering validate the bounded visual catalog.
- Model HTML/JavaScript is not executed. Markdown code examples remain code;
  this feature does not heuristically reinterpret arbitrary fenced text.
- Visuals are keyed by tool invocation, so subsequent text streaming and normal
  history refreshes preserve local controls and practice state.
- Failed/malformed outputs retain a readable fallback. An invalid visual cannot
  take down the composer, approvals or file viewer.
- Project export capability still governs downloads. Interactive controls are
  local exploration, never execution, permission grants, or server mutations.
- Flow diagrams use lazy-loaded Mermaid 11.17.0 with its standard default theme,
  typography, spacing and layout. Source direction is preserved at every width.
  The inline image opens a larger viewer at actual size. Zoom, Fit, Actual size
  and Copy Mermaid live in that viewer. Escape/Close restores focus to the opener.
  The complete connection list remains available below the inline preview.

## Research and rationale, 19 October 2026

- [assistant-ui generative UI](https://www.assistant-ui.com/docs/tools/generative-ui-primitive):
  render validated components as message parts alongside text and tools. An
  allowlist alone does not validate props; Lori keeps its existing strict schema
  and host-authored renderers rather than adopting a new renderer dependency.
- [W3C complex images guidance](https://www.w3.org/WAI/tutorials/images/complex/):
  diagrams and graphs need complete text equivalents. Lori retains descriptions,
  connection details and original-data copy, with readable failure alternatives.
- [Nielsen Norman Group progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/):
  reduce surface complexity by deferring secondary controls. Lori removes the
  artifact management flow and leaves source material, prose and useful visuals
  in the current conversation.

Earlier open-source research on LibreChat, assistant-ui and NoobBook informed the
previous side-preview experiment. The user rejected that experience; it is removed.
The current implementation reuses the existing inline response contract.

## Verification

The broad frontend runs passed 2,912 desktop tests and 757 Cloud tests. Regression
coverage includes Markdown/visual order, streaming state preservation, malformed
payloads, read-only/export behavior, long labels, narrow layout, quiz/flashcard
interactions, normal file editing and the conversation shell. Visual fixtures were
checked at 1280px and 390px in both themes with no page errors or page overflow.
Cloud builds run from an isolated source copy to preserve the running dev server.
Live-provider generation quality and signed/cross-platform qualification remain open.

Final production builds passed for desktop (including bundle budgets) and Cloud
(Webpack in an isolated source copy). Final focused runs passed 92 desktop and
76 Cloud tests. The design detector reported no findings.

## Mermaid renderer review

The previous custom SVG layout engine is removed. Existing validated diagram
blocks are serialized to a host-owned flowchart grammar with generated node IDs
and escaped labels. Arbitrary Mermaid code fences, directives, callbacks and
model configuration are not newly enabled. No backend schema migration is needed.

[Mermaid usage/security documentation](https://mermaid.js.org/config/usage) and
[configuration reference](https://mermaid.js.org/config/setup/mermaid/interfaces/MermaidConfig.html)
informed strict mode, disabled HTML labels, protected configuration, and bounded
input. Rendering is serialized and performed in a temporary offscreen host; the
result is checked and displayed as a local SVG image. Returned SVG is not inserted
into the conversation DOM. Temporary hosts and image URLs are released, obsolete
render completions are ignored, and failures show the full textual graph.

Lori does not override Mermaid colors, fonts, node/edge spacing, curve type or
layout. The stock default theme is shown on a white canvas in both app themes.
Resizing never rewrites the source or switches the graph direction. Inline zoom
controls are removed; the enlarged viewer shares the original image URL. It closes
immediately when its source changes or the conversation becomes inactive.

Final validation: 2,917 desktop frontend tests and 762 Cloud frontend tests passed,
including source escaping, output checks, stale render handling, image cleanup
and fallback behavior. Both production builds passed; desktop entry and aggregate
bundle budgets remain within their existing limits. Real-browser checks at 1280px
and 390px covered both themes, theme switching, Unicode, hostile labels and source
connections, with no page errors, page overflow, active SVG content, script-probe
execution or leftover render hosts. Live-provider and packaged cross-platform
qualification remain outside these checks.

### Standard appearance and expansion validation

The latest focused runs passed 202 desktop and 107 Cloud tests. Both production
builds passed. Browser checks verified the stock default colors, click to expand,
zoom, Fit, Escape, focus restoration, unchanged source on mobile, and no page
overflow/errors at desktop and narrow sizes. No full live-provider or packaged
release qualification is claimed by these UI checks.

## Saved artifacts in the existing workspace (2026-10-19)

Reusable structured outputs now use ordinary `*.lori.json` workspace files. The
file contains the existing `present_visual` object, without a wrapper. All catalog
formats render through the existing viewers: diagrams, mind maps, timelines,
quizzes, flashcards, slide decks, reports, charts, tables, metrics, steps,
calculators and simulations.
Valid earlier JSON exports also receive a preview when their entire contents fit
the catalog. Other JSON remains source text.

Study and briefing artifacts (mind map, quiz, flashcards, slides, report) fill the
existing workspace preview as a focused stage: a kind label, a collapsible
summary-and-sources disclosure, and the interactive body. Mind maps are a pan and
zoom canvas with per-branch collapse, topic details and PNG download. Quizzes
reveal right/wrong on selection with optional hints and per-option rationales,
then show results and retry missed questions. Flashcards flip and track got
it/missed. Slides render 16:9 designed layouts with a thumbnail rail, speaker
notes and a full-screen Present mode. Inline transcript copies keep the compact
layout and offer a larger view in the shared dialog. All practice state stays
local; slide decks are data, not executable content. `.pptx` files continue
through the presentations skill.

The existing Preview/Edit controls, file explorer, document tabs, local immutable
revisions, autosave, file approvals, hash conflicts and export permissions remain
the workflow. Local agents use `write_file` and `present_files`; Cloud agents use
`write_file` and the existing changed-file delivery. Cloud project and private
conversation file panels share the renderer. Desktop Cloud project text files
also pass through the common document workspace. No artifact library or Studio UI
is added. Office, PDF, images and Markdown retain their existing document paths.

Artifact admission uses the same closed data-only schema as inline visuals:
canonical data at most 48 KiB, formatted source at most 96 KiB. Agent text writes
and edits to `*.lori.json` are validated before saving. Invalid files uploaded or
edited by a person remain inspectable in the source editor; preview rejects them
without executing content. A rendering failure is contained, and stale reads
cannot replace the selected revision. Cloud reads page through complete artifact
contents, checking file ID, version, hash, cursor progression and byte limits.
Study answers, learned cards and calculator inputs stay local to the viewer;
they do not write to the file. Export controls use the existing project permission.

Generation guidance asks agents to read selected sources first, preserve actual
file/hash/page references in source notes, apply audience/language/difficulty
preferences, label incomplete coverage and assumptions, and preserve unrelated
blocks during refinement. Local detailed guidance loads only with the existing
visual tool group to preserve small-context operation. Sources are human-readable
notes; this does not claim automatic citation verification, freshness detection
or project-wide retrieval. Cloud refinements default to a new named file so the
previous deliverable remains available; explicitly requested in-place edits use
the current hash.

### Reference review and decisions

NoobBook was read only. Its `StudioContext.shared.ts`, mind map generation hook,
and backend `mind_map_service.py` connect project/source selection, generation
direction, previous content and edit instructions. Lori adopts that continuity
through its existing file and chat contracts rather than copying its Studio UI.

Google documents source-based outputs, selected sources and inspectable generation
prompts in [Gemini Notebook](https://support.google.com/gemininotebook/answer/16206563?hl=en),
and audience/focus/difficulty controls in its
[flashcard and quiz guide](https://support.google.com/gemininotebook/answer/16958963?hl=en-GB).
Anthropic describes reusable, editable outputs beside chat in its
[artifact guide](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them).
The implementation decision is to make Lori's existing workspace own saved
outputs and refinement. Audio/video generation, executable applications, new
sharing systems and automatic source indexing are separate capabilities and are
not introduced by this change.

### Workspace artifact verification

- Desktop frontend: 2,964 tests passed; the final selection-feedback change also
  passed the focused 17-test document workspace suite. Existing performance
  budgets passed in the production build.
- Cloud frontend: 829 tests passed. Cloud API: 660 passed, 44 skipped, including
  PostgreSQL approval, durable save, invalid-edit preservation and malformed-file
  rejection tests. Optional suites remain skipped under their existing gates.
- Desktop Work Rust: 336 passed, 3 ignored. Clippy with warnings denied, Rust
  formatting, TypeScript checks, scoped lint and both production builds passed.
- Headless Chromium checked the actual workspace components at 1280px and 390px
  in both themes: preview/source switching, diagram rendering and study controls
  worked with no page errors or page overflow. These use controlled API fixtures.
- NoobBook remains unchanged. Live model generation, signed/native application
  interaction and cross-platform release qualification were not performed.

## Readable artifact links and navigation

Chat links and response delivery actions use the artifact title recovered from
validated, successful built-in file writes. When that title is unavailable, the
filename stem becomes a readable fallback (for example, `cash_runway.lori.json`
becomes “Cash runway”). Partial edits discard stale title metadata. Existing
descriptive link labels stay intact, and tool history retains original filenames.

The link's navigation cue and the delivery action say “Open in workspace.” Click
and keyboard activation preserve the original path, document identity and hash;
Cloud links still require an exact accessible workspace file. External URLs and
ordinary document filenames keep their current behavior. No extra file reads,
renames or generated-file changes are needed.

Validation: 119 focused desktop tests and 83 focused Cloud tests passed, along
with TypeScript, scoped lint, both production builds and desktop bundle budgets.
Eight Chromium fixture scenarios covered mouse/keyboard activation, both themes,
1280px/390px widths, correct file targets, and no page errors or overflow.
