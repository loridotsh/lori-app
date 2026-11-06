# Changelog

All notable changes to Lori are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Image and video models** — 0G's media models sit in the model menu. Choosing one and sending a prompt generates the file, saves it in the conversation and shows it in the reply. See [Image and video generation](docs/WORK_MEDIA.md).
- **Hosted accounts** — `LORI_PUBLIC_SIGNUP` lets anyone create an individual or enterprise account on one deployment, with each account as a separate tenant.

### Fixed

- **Sandbox writes** — the model is told that only the working directory and `$TMPDIR` are writable, and a command that hits a read-only path now gets a precise way to recover.
- **Tool call IDs** — IDs a gateway repeats in the stream are no longer doubled, and any ID over 64 characters is shortened on the wire. Long GPT 6.1 runs failed with `string_above_max_length` because of this.
- **Text-only models** — page images are replaced with a note instead of failing the run with `model_not_capable`.
- **Passing provider failures** — 408, 429 and 5xx responses are retried before any output reaches the member, and web research retries once.
- **Retries** — a retry after a failed run can read the steps that already finished instead of repeating them.
- **Failure messages** — a low provider balance has its own message, a refused request can be retried, and logs name the field a provider refused.
- **Usage** — a later zero from a provider no longer erases a real token count.
- **Skill references** — a shortened name such as `creation.md` now finds `references/creation.md`.

### Changed

- **0G reply limits** — 0G models use their listed output limit, up to the 32,768 tokens one stream can carry, and a refused budget is retried once within the limit the provider names. Reply budgets now shrink to fit the prompt rather than reserving room the prompt needs.
- **Large tasks** — a run may work for 60 minutes, a reply is no longer cut after 10 minutes of streaming, keep-alives cover long thinking, and a command may be 100,000 bytes.
- **File delivery** — files are served in 4 MiB ranges for seeking, reads have their own per-member allowance, and generated files have a separate 256 MiB per-file and 2 GiB per-conversation allowance.
- **Inline generative responses** — validated metrics, charts, searchable/sortable tables, calculators, step explainers and paused simulations appear among response text and activity. Controls explore local data; approvals remain explicit. Readable fallbacks and stable response identity cover failures and streaming reconciliation.
- **Long conversation history** — byte-bounded pages and a Load earlier messages control preserve complete replies, older conversation text, drafts and reading position. Desktop transport supports the bounded escaped-message envelope.

- **Cloud Work follows Work access** — there is no separate Cloud Work switch. Enabling Work in Manage → Work access (organization, team, or member) makes Cloud Work available; disabling it cancels runs in progress within 15 seconds. Migration `029` retires the legacy per-organization flag.
- **Work off is enforced end to end** — `/work/cloud` answers with a real redirect to Work access before rendering, the Manage Work tab and Cloud Work controls are disabled with an explanation, and the API continues to refuse every Cloud Work operation.
- **Settings, Memory, LLM Providers and Plugins redesigned** — grouped settings with validated retention, toggles in place of native checkboxes, a rebuilt memory editor, and provider and plugin logos.
- **Chat rendering** — animated thinking indicator with queue and worker hints, streaming text, code blocks with copy, tables and quotes, and anchored result notices with Try again.

- **Agent activity reads in order** — tool calls appear between the sentences around them instead of in one block. Calls group under a short summary and expand to each step, with a verb and icon per tool, status and duration, command output, file lists, search matches, file text and line diffs. Approval cards show the exact command, diff or plugin action. Needs migration `030`; older runs show their tools first.
- **Composer and files** — drop, paste or pick files (up to 10 at a time); `@` mentions files, plugins and skills and highlights them in the sent message. The Files pane is now a folder tree with a filter, Upload, rendered Markdown, CSV tables, image previews and PDF opening, and every reply lists "Files from this response" that open in the pane.
- **The assistant knows its workspace** — each round it is told the date, the files, connected plugins and skills, what `@` pointed at, and the working and safety rules.
- **Unanswered approvals expire** after `WORK_CLOUD_APPROVAL_TIMEOUT_MINUTES` (default 15) and the run continues, declined, instead of waiting forever.
- **Workers serve several runs at once** (`WORK_CLOUD_WORKER_CONCURRENCY`, default 4), so one waiting approval no longer blocks other members.
- **Models use their real limits** — Cloud Work no longer treats every model as a 16k-context, 4k-reply model. `gpt-6-luna` and other published OpenAI models use their full context window (1,050,000 tokens for `gpt-6-luna`), replies can reach 16,384 tokens, and the limits show beside each model. Operators can describe other models with `WORK_CLOUD_MODEL_LIMITS`.
- **Excel workbooks open as a live spreadsheet** — an `.xlsx` in the Files pane is no longer only pictures of pages. It opens as a real sheet with tabs, number formats, fonts, fills, borders, merged cells, frozen panes, column widths and hidden rows; a formula bar and address box; keyboard navigation, range selection, copy, cut and paste (to and from Excel and Sheets), undo and redo. Typing a value or a formula recalculates everything that depends on it, across sheets, with over 120 worksheet functions (`SUM`, `IF`, `SUMIFS`, `VLOOKUP`, `INDEX/MATCH`, `XLOOKUP`, text, date and loan functions). Edits save by themselves as a new version of the same file, and only the changed cells are rewritten: charts, images, styles, conditional formats and everything else are carried across byte for byte, shared formulas stay shared, and Excel is asked to recalculate on open. A "Pages" view keeps the printed layout, charts included. A workbook that changed while you were editing keeps your edits and offers a copy; an unreadable, protected or very large workbook falls back to page pictures and says why. Formulas that use a function the view cannot calculate keep the value stored in the file and are listed in a note. Needs no migration; the new `PUT /v1/work/cloud/files/:id/content` replaces a workbook's bytes against the version it was opened from.
- **Previews open instantly** — a Word, PowerPoint or PDF file now starts rendering the moment it is saved or generated (its first 8 pages, then reading ahead to page 24, behind anything a member is actually waiting for), so by the time it is opened its pages are usually ready: a few milliseconds and one request per page instead of a one-second wait on a spinner. Opening a file that is not ready yet takes about a third of a second: the worker waits for work inside a held request instead of polling every 750 ms, converts a document once and reuses the converted PDF for its later windows (the Office conversion was most of every job), renders 8 pages per job instead of 4, and the browser asks for the finished picture first, getting the page count with it, and is told the instant a page is ready instead of polling. Rendered pages are kept for 6 hours instead of 15 minutes, and a new version of a file retires the old one's pages at once. A page that is still being prepared is a blank sheet of paper in its final shape, with no spinner; "Loading…" lines for files and images stay hidden for the first 300 ms so fast loads never flash. Needs migration `035` (job priority).
- **The sheet view draws Excel tables** — a workbook can mark a block as a table and name a style (`TableStyleMedium2`...), which then supplies the header fill, banded rows and totals row; the file stores none of that on the cells, so headers whose text is white looked empty. The view now reads each sheet's tables and draws the built-in Light, Medium and Dark styles from the workbook's own theme colours, with a cell's own formatting still winning. Text whose colour matches its background (white on white, which Excel cannot show either) is drawn in readable ink and a note names the cells.
- **Lori checks workbooks for visible defects** — the design kit gains `python -m lori_design.lint file.xlsx`, which reads any workbook (including openpyxl ones) and reports invisible text, coloured rows with nothing in them, formulas with no stored result, numbers too wide for their column and code-style titles (`unit_price`). The Spreadsheets skill requires running it and fixing every line before the file is reported as done, tells the model to rebuild a kit workbook rather than re-save it with openpyxl (which discards stored results, and used to lead to a duplicate "recalculated" file), and the kit's `first=True` sheet now really is the first tab even when built last. Table-header and summary mistakes like an unfilled white header row can no longer pass unnoticed.
- **"Thinking" is cleaner** — no trailing dots, and the shimmer that shows work in progress is wider and crisper, with a lighter resting colour so the sweep is visible in light and dark.
- **Word, PowerPoint and PDF files are still page previews** — they cannot be edited in the browser yet. Editing, selecting text and searching them needs a text layer from the sandbox's document runtime, which is vendored and pinned.
- **Documents Lori builds look designed** — the sandbox ships a design kit, `lori_design`, for Word, Excel, PowerPoint and PDF: a restrained palette, Arial, real heading and list styles, tables with repeating header rows, KPI strips, callouts, native charts, frozen headers and hidden gridlines in workbooks, flat 16:9 slides with measured text, and typeset PDFs with page numbers. The Documents, Spreadsheets, Presentations and PDFs skills were rewritten for Cloud Work (the vendored desktop versions describe a "document job" and "publish" step that does not exist here) and served in their place; the vendored catalog is untouched.
- **Lori now looks at what she builds** — `render_document` shows the pages straight to the model (up to six per call), needs no approval and saves nothing, so checking a deliverable no longer adds approval prompts or stray `page-N.png` files. The prompt and tool descriptions tell the model to build in one command, then validate and look.
- **The approval choice in the composer is a menu** — "Ask me" and "Approve for me" open from one quiet control with a description of each, a check beside the current mode, a lock when your organization requires Ask me, and a spinner while saving. The native dropdown (which overlapped the composer) is gone.
- **Tool results read as results** — plugin tool search lists tools with their access level and inputs; skills show what was loaded; document inspection, validation and rendering show sheets, checks, warnings and page thumbnails; plugin responses that carry JSON show as fields and tables. Bookkeeping (`invocationId`, `kind`, hashes) is hidden, odd or truncated results still render, and a failed command's hint is shown prominently.

### Upgrade notes

- **Cloud Work is no longer a separate opt-in.** Migration `029` retires the per-organization Cloud Work switch and sets it on for every organization, so any organization that already has Work enabled (and a provider and model assigned) gains Cloud Work on upgrade, running on your server with the company provider keys. Organizations that want Cloud Work off must turn Work off in Manage → Work access, or remove the worker. Review this before upgrading if Cloud Work was deliberately left off.
- Install the worker (or run `dev:cloud`). Without a configured worker secret the API reports Cloud Work as not set up, and the app says so rather than treating Work as off.

### Fixed

- **Long responses no longer fail with "The response could not be completed"** — two separate causes. The worker gave every API call 30 seconds to start answering, but a model request only answers once the model starts: a reasoning model with large tool results in context could take longer, and the run died as `api_timeout`. Provider requests now wait up to the API's own 10-minute ceiling. And a response stopped dead at 16 provider rounds. It now has up to 32, and the last is always a tool-free wrap-up that reports what is finished and what remains and invites the member to reply "continue" (everything completed is saved). Migration `034` raises the round limit. The assistant is also told that steps are limited and to batch independent calls, so loading six skills one by one no longer burns six steps.
- **Context is managed per model, from the model's real window** — Cloud Work no longer assumes 32k tokens for every model that is not an OpenAI one. Each model's limits come, in order, from an operator override, a ceiling learned from the provider's own "context too long" refusal, the provider's model metadata (Anthropic `max_input_tokens`, Gemini `inputTokenLimit`/`outputTokenLimit`, OpenRouter, Together, Groq, Mistral and Fireworks fields; asked once, cached, never inside a database transaction, with the key sent only to the provider's own origin), the reviewed published table, a conservative family estimate, then the default. When history would not fit, it is now compacted in five steps instead of failing the run: old tool results become short receipts (the full output stays readable with `read_tool_output`), old screenshots are dropped, long older messages are shortened, and only then are the oldest turns dropped; the member's latest message and the newest results are never touched. A conversation of more than 100 messages used to send the oldest 100 and lose the latest turns; it now sends the newest.
- **A hang when compacting tool results is fixed** — a tool-result budget smaller than the receipt's own fields sent the bounding loop into an endless loop.
- **Approvals and activity** — the approval card is redesigned as a flat card with the preview, a quiet footer with the primary action last, a spinner on the button pressed, and structured rows for generated files. After approval, a running tool says whether it is queued or running in the sandbox, with a live clock, in its row and in a collapsed group's heading. The status dot before "Used N tools" is gone (state is written and coloured in the heading), and a multi-line command is named by its first line.
- **Only the files you asked for are offered under "Files from this response"** — the pictures Lori renders to check a document's layout (`page-1.png` and similar, and scratch folders) no longer get cards.
- **A wrong tool parameter no longer ends the run** — the worker used to validate every call against the full schema and abort the whole response on the first mismatch (a number sent as text, an extra field, a limit over the maximum), before the model could see what was wrong. The API now owns validation: it quietly repairs common slips (numeric and boolean text, a quoted JSON list, `null` or blank optionals, unknown fields, a `limit` or `timeoutSeconds` over its maximum) and otherwise returns an error naming the exact parameter, so the model corrects it and carries on. Plugin and skill calls with bad arguments are returned the same way instead of aborting the run. Paths given to tools are literal, so `$TMPDIR/…` is refused with an explanation instead of creating a folder named `$TMPDIR`. A model that invents a tool now ends with "The model sent an invalid tool request" instead of a generic failure.
- **Document previews** — PDF, Word, Excel and PowerPoint (including `.doc`, `.xls`, `.ppt`, `.odt`, `.ods`, `.odp`) now open as one continuous, scrollable document instead of one page per round trip. Pages load as you scroll, the worker renders four pages per job and no longer idles two seconds between jobs (page 1 in about a second, the next pages instantly), and the page counter, page-number field and zoom (50–300%, keeps your place, scrolls sideways when zoomed) work in light and dark. Memory stays bounded on long documents. Failures are specific: a damaged or password-protected file, a busy or unavailable renderer, and a single page that failed each say so and offer the right action. A file that changed while open now offers "Load latest version" instead of a Retry that could never succeed. Preview polling has its own rate limit so scrolling a long document cannot be throttled.
- **An approved edit is written exactly as shown** — text containing `$$`, `$&` or `` $` `` could be altered by JavaScript's replacement patterns when `edit_file` applied it. The edit is now spliced in literally.
- **A run waiting for approval is no longer failed by the worker's 15-minute generation limit**; only time spent working counts, and unanswered approvals expire on their own.
- **Editing keeps a file's byte-order mark and Windows line endings**, so saving a CSV from Excel no longer changes how Excel reads it.
- **Approval cards show everything being approved** — plugin and tool inputs are open and unredacted, and large writes can be paged through in full instead of stopping at 2,000 lines.
- **File and plugin names in the assistant's instructions are quoted** and stripped of invisible and direction-changing characters.
- Pasting copied spreadsheet cells keeps the text instead of attaching a picture of it; files created by commands appear under "Files from this response"; opening a file from chat during a save, or going back during a load, can no longer leave the workspace disabled.
- **OpenAI reasoning models now answer** — Cloud Work sent `max_tokens`, which current OpenAI models reject, and tool use with reasoning on Chat Completions, which they also refuse. The API now sends `max_completion_tokens` and retries once with reasoning off on that specific refusal. A conversation that outgrows a model's window is reported as such, with a one-click new conversation.
- **Why a response failed** — the API records the category of a company-provider refusal (rejected key, unknown model, rate limit, outage, rejected request) and the web app explains it, instead of a generic "Response failed".
- Silent stream renewals no longer show "Reconnecting".
- Sidebar: collapsed layout, Manage link in the rail, search scope message, and the development build badge no longer covers the organization name.
- Work-only API routes are blocked at the edge and in the web proxy; `TRUST_PROXY` trusts only private-network proxies unless given an explicit list; `docker compose` edge ports now match explicit `LORI_ADDRESS` ports.
- **Commands no longer fail on files Lori forgot to hand them** — every command starts in an empty sandbox, and a model that forgot `inputPaths` (or expected a file created earlier in the same run to be there) got "No such file". Workspace files named in a command are now added automatically, and when one still fails the result says exactly which file exists but was not provided.
- **Excel previews no longer show blank totals** — workbooks written by XlsxWriter store `0` beside each formula; the preview renderer trusts stored values, so cross-sheet totals looked empty. The design kit writes the real result next to every formula it creates.
- **"Thinking…" no longer repeats the running tool's name** under the tool's own row.

## [0.1.2] - 2026-09-14

Operator-focused Docker distribution, clearer first-time setup, and release artifacts for private GHCR installs.

### Added

- **OCI Compose stack** — publish `lori-enterprise-stack` on GHCR so operators deploy with Docker Compose only (no application source).
- **Offline Docker bundle** — `lori-enterprise-docker.tar.gz` on each GitHub Release for Portainer and air-gapped compose installs.
- **Setup token guide** — `/setup` explains how to run `setup-token` on the Docker host, with copy-ready commands and expiry guidance.
- **Operator documentation** — `deploy/OPERATOR.md` for private registry login, local HTTP ports, and upgrade paths.

### Improved

- **Release workflow** — digest-pinned images, compose overrides, and fixed GitHub Release asset uploads.
- **Compose edge ports** — long-form port mappings compatible with `docker compose publish`.
- **Repository layout** — Enterprise control plane at repository root (no nested `enterprise/` tree).

### Fixed

- **First-admin UX** — development and production setup flows surface token retrieval instructions in the dashboard.
- **GHCR release notes** — release job attaches the Docker bundle using supported `gh release` syntax.
