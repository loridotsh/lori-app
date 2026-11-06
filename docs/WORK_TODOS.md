# Work todo tools

Work's local and Cloud agents can keep a bounded, conversation-owned plan using
`read_todos` and `write_todos`. This extends the existing harness and tool-receipt
storage. It does not schedule work or grant tool permissions.

## Contract

`read_todos({})` returns `todoList: { revision, todos }`. New conversations start at
revision 0. Each item contains a stable `id`, `content`, and a `status` of
`pending`, `in_progress`, or `completed`.

`write_todos({ expectedRevision, todos })` replaces the full list and increments
its revision. Empty lists clear the plan. A stale revision fails without changing
the list; the agent must read and reconcile the current version before writing.
Use at most 20 items, unique ASCII IDs up to 64 characters, nonblank content up to
240 UTF-8 bytes, at most one current item, and a serialized request up to 6 KiB.

These tools need no file root or action approval: they only record planning
metadata. Existing Work access, project tool permissions, worker leases,
cancellation and request-id deduplication still apply. Todo receipts cannot be
used as evidence for `update_task_progress`.

## Persistence and recovery

Only successful `write_todos` receipts change the plan. Local Work reads the
latest successful update in SQLite message order; Cloud reads the highest
conversation-owned revision in PostgreSQL. Cloud project content continues to
use the existing encryption and RLS boundaries. Plans are private to each
conversation, including inside a shared project.

The current plan is injected as untrusted context each model round, independently
of compacted history. The bounded task-list tools are available immediately in
Local and Cloud Work, without a plugin connection. Requests for a conversation
checklist use these tools; an explicitly named external task app uses its own
connection. Local recovery applies the existing memory-revocation guard before
returning content.

Both conversation renderers show one expandable checklist per assistant response,
updated in place as successful snapshots arrive. Successful internal bookkeeping
is omitted from conversation activity; failed updates use a plain-language status
while the complete receipt remains stored. Active styling appears only during a
running response. Expansion is preserved across updates and reset for a new plan.
Checkmarks are agent-reported progress, not independent verification. Task text
is rendered as plain text, and long names wrap within the compact card.

## Deployment and qualification

Apply migration `036_cloud_todos.sql` before starting the updated API. It adds
only revision metadata and a partial index to existing tool receipts; planning
content stays in encrypted receipt fields. Rebuild the worker to include the
shared Work guidance version 4. Catalog/runtime regeneration uses the existing
`vendor-work-catalog.mjs` and `vendor-work-runtime.mjs` scripts. The catalog also
generates the shared TypeScript todo parser from Lori's source and verifies its
integrity.

Regression coverage includes shared Rust/TypeScript conformance fixtures,
revision conflicts, cancellation, SQLite reopen, memory revocation, cross-run
recovery, request replay, project encryption/RLS, desktop Cloud mappings,
real-worker scripted-provider execution, and checklist interactions. Scripted
providers establish harness behavior; they do not qualify live-model task
planning quality or signed application packages.

## Research basis

- [LangChain's todo middleware source](https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain/src/agents/middleware/todoListMiddleware.ts): use lightweight structured plans for substantial tasks, keep the current step explicit, and update the plan as work progresses.
- [Anthropic's long-running agent harness guidance](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents): preserve structured progress outside the model context and verify actual outcomes before declaring completion.
- [Microsoft's AI interaction guidance](https://fluent2.microsoft.design/responsible-AI): show meaningful progress and retain clear human control over actions.
