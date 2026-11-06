# Cloud Work generative responses

## Reviewed functionality and constraints

Cloud Work is a private, member-owned cowork workspace. Organization Work policy
and assigned gateway/model access authorize admission. The API owns prompt
reconstruction, provider requests, context and round budgets, database state,
and task leases; the Rust worker drives provider rounds and isolated execution.
Conversation submission is revision checked and idempotent. Events are persisted
before SSE delivery, replayed by sequence, and reconciled with durable history.
Cancellation, lease expiry, denied approvals, unknown outcomes, and gateway
failures have distinct states.

Tools include workspace listing/search/text reads and hash-checked writes;
PDF/Office extraction, inspection, rendering, conversion and recalculation;
commands with explicit inputs in fresh offline sandboxes; staged output with
separate apply approval; public web research; plugin discovery and MCP calls;
bundled skills; and private conversation/personal memory. Effective member
approval preferences and organization restrictions govern mutations. Unknown
external outcomes must not be automatically repeated. File previews and
conversation downloads remain separately authenticated and conversation owned.

The response UI previously interleaved Markdown and collapsible tool activity
using durable UTF-16 text offsets. Approval cards, file changes and errors already
had their own components. Adding generative UI must preserve these boundaries:

- Untrusted model/plugin content cannot execute markup, code, arbitrary callbacks,
  network requests, authenticated file fetches, or approvals in the renderer.
- A partial or failed tool call is not a successful visual. Replayed events and
  restored snapshots must produce the same result without re-running a tool.
- Large visual data must survive the smaller model-output preview budget without
  wasting the context window on a duplicated dataset or an enormous schema.
- Streaming completion must preserve interactive controls rather than remount
  the assistant response. Later deltas must retain each visual's identity.
- A failed renderer must leave the conversation, composer, approvals and files
  usable. Unknown versions must degrade to a readable summary.
- Visual calculations are model-supplied explanations, not authoritative business
  calculations; units, sources and material assumptions must remain visible.

## Implementation

`present_visual` is an additive, read-only tool offered with and without the
document sandbox. The server validates a versioned closed catalog, records its
result through existing tool receipts/events, and returns a compact presentation
acknowledgment to the model. No new database schema, permissions, provider SDK,
network surface, worker image or client mutation action is required.

`packages/contracts/src/visuals` owns the shared types, schema, bounded arithmetic,
and validation used by both API and browser. The model schema is a compact
grammar derived from that catalog. It does not relax server validation. Visual
calls bypass permissive argument normalization: forbidden extra keys are rejected,
not silently removed. Payloads are limited to 48 KiB and six blocks.

The catalog and renderers adapt Lori Desktop's data-only visual foundation:

| Block | Interaction and limits |
| --- | --- |
| Metrics | Up to four labeled values with explanatory detail |
| Chart | Bar/line; up to 40 labels and four matching series; exact-value selector, series visibility and data table |
| Table | Up to 100 rows and six columns; search, stable sort and eight-row pagination |
| Calculator | Up to six bounded inputs/four outputs; numeric entry, sliders, reset, finite-result handling |
| Steps | Two to twelve steps; keyboard-accessible navigation and readable content |
| Simulation | Up to five parameters, one shared bounded timeline, four outputs, track/plane scene; explicit Play/Pause/seek/reset |

Visuals are rendered as their own chronological response parts outside tool
activity disclosures. Text, approval cards and changed-file controls retain their
existing behavior. Streamed and saved responses share `response:<runId>` identity;
visual parts share `visual:<invocationId>` identity. A later attempt with the same
title replaces obsolete failed visuals; successful visuals and the latest failure
remain visible, and all receipts remain durable. Tests exercise calculator state
across repeated tool events, further deltas and terminal history reconciliation.

The browser revalidates completed visual arguments only after a matching
`cloud_visual` successful receipt. Arguments already exist in both events and
history, so model-output truncation cannot lose the dataset. The complete output
also remains available through the existing owned tool-output endpoint. Preview
compaction is bound to `present_visual`, so plugin JSON cannot impersonate it.

All content is React text and trusted controls. No HTML injection, iframe, remote
image, dynamic import path, `eval`, `Function`, or model-selected action exists.
Arithmetic uses a bounded parser, rejects unknown symbols, nonfinite results and
intermediate/final magnitudes above 1e12,
and reports combinations outside the formula's domain in place. Charts offer
labeled data and non-color cues; bars include zero. Native form controls and
semantic tables expose keyboard and screen-reader access. Simulation playback
starts paused, uses elapsed timestamps, and pauses on hidden document, offscreen,
inactive view or unmount; it never auto-resumes. Copy exports full original data
and explicitly labels default calculator/timeline inputs. Exploration state is
local and intentionally resets on a page reload; it never changes saved data.

## Research applied

- [AI SDK: Generative user interfaces](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces): tool results map to trusted components with explicit pending, success and error states. Applied to the existing Cloud Work runtime without a transport migration.
- [A2UI: Catalogs](https://a2ui.org/concepts/catalogs/): application-specific catalogs, versioning, validation on both sides and graceful fallback. These principles inform this catalog; this implementation does not claim A2UI protocol compatibility.
- [W3C: Disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/): semantic buttons, expansion state and controlled content for optional chart data and existing tool details.
- [W3C: Sequential status/log updates](https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA23.html): sequential chat semantics and polite status announcements. Existing response-status announcements are preserved; token deltas are not repeatedly announced. Local controls expose appropriate output/status labels.

## Qualification

Automated coverage includes catalog conformance/size/shape rejection, code and
action injection, arithmetic grammar and undefined results, chart data/series
controls, table filtering/sorting/pagination, calculator reset/input errors,
step navigation, simulation time/visibility cleanup, renderer and clipboard
failure isolation, chronological response placement, replay and terminal
reconciliation, and PostgreSQL-backed privacy/idempotency/durable large payloads.

A live synthetic task with the configured company model generated a chart, table
and calculator; browser verification covered sorting, calculator changes,
restored history, a 375px viewport, and a fresh console without errors. Values
were explicitly illustrative. No files, memory notes, plugin actions or provider
configuration were changed by that task. It remains in conversation history as
`UI QA — synthetic Gen UI check` for inspection.

Passing local suites and a live configured-model check do not qualify every
allowed provider/model combination, real iOS/Android screen readers, all browsers,
or a deployed container release. Deployment must build contracts before API/web
(the existing build pipeline does this), then validate a real conversation,
reconnect, approval and file workflow in that environment. Conversation text now supports byte-bounded earlier pages without deleting history.
The existing bounded per-page tool activity limits still apply. Long-term visual export, collaborative
control state, arbitrary generated web apps, and actions from visual controls
are outside this catalog.
