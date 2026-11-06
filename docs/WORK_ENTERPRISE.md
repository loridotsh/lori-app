# Enterprise desktop Work governance

This service administers the existing Lori desktop Work runtime. Work projects,
conversation content, documents, memory, plugin credentials, and user provider
credentials stay on the desktop. Company model gateway requests necessarily pass
through this service to the configured provider; they are streamed and are not
saved as conversation records or audit payloads. Code keeps its existing APIs,
policy tables, provider assignments, and inventory.

## Policy and roles

Migration `021_work_governance.sql` provisions explicit organization Work policy
rows. Existing and newly configured organizations start with Work enabled, all
three personal installation categories allowed, no assigned catalog items or
models, Ask me not forced, and memory allowed. Missing or malformed stored
organization Work authority returns `503 work_policy_unavailable`.

Organization administrators edit organization and global member Work policy.
Organization administrators and the relevant team administrator edit team and
team-member Work policy. Existing organization/member tenant checks and shared
organization policy locks serialize changes. All Work mutations increment the
existing organization revision and emit metadata-only audit events.

Organization and team grants combine by union. Global member overrides win after
that union. Team-member overrides change that team's contribution. A team cannot
remove another team's or the organization's grant. Explicit catalog exclusions
remain exclusions when no other scope grants the same resource. Work catalog
IDs come from the app-bundled Work plugin/skill manifest, separately from the
Code marketplace. Provider entries explicitly map to supported company gateways.

`forceAskMe` and `memoryAllowed` are organization settings. Team and member
policy cannot weaken or replace those settings. Effective model lists are
provider-specific allowlists; an explicitly empty model list admits no model.

## API contract

The public edge adds `/api` to the following API paths:

- `GET /v1/work/policy` returns the viewer's effective `EnterpriseWorkPolicy`.
- `GET /v1/work/catalog` returns the Work catalog and connected company provider
  IDs, without credentials. `/v1/admin/work/catalog` is an alias.
- `GET/PATCH /v1/admin/work/policy` manages organization Work policy.
- `GET/PATCH/DELETE /v1/admin/work/members/:memberId/policy` manages global member
  overrides.
- `GET/PATCH /v1/teams/:teamId/work/policy` manages a team's contribution.
- `GET/PATCH/DELETE /v1/teams/:teamId/work/members/:memberId/policy` manages
  team-member overrides. `memberId` is the organization membership ID.

Direct PATCH bodies are `{expectedRevision, policy: WorkPolicyInput}`. Member
PATCH bodies are `{expectedRevision, overrides: WorkPolicyOverrides}`. DELETE
requires an `expectedRevision` query parameter and restores inheritance.
Revision conflicts return `409 policy_revision_conflict`.

`GET /v1/desktop/bootstrap` adds `workPolicy` and
`workManagedProviderGateways`, preserving existing Code fields and desktop
protocol v1. Its ETag includes the Work schema version. Bootstrap retries up to
three times if shared Code/Work revisions change while assembling the response,
then returns retryable `409 policy_sync_conflict` rather than revoking access.
Work policy schema version is 1; clients must understand it before executing
managed Work. These additive fields do not make older desktop versions enforce
Work policy; deployment requires the coordinated Work-aware desktop release.

## Company providers

Company connection identity, encrypted upstream credential, and rate-limit
configuration are shared. Existing gateway `enabled_models` remain Code settings;
Work provider and model assignments are separate. Work metadata includes only
the primary provider protocol route. Assigned gateways with no allowed models
remain visible as reserved, unusable connections so a saved personal credential
cannot become a fallback. They receive no gateway credential.

`GET /v1/desktop/work/provider-credentials` returns the usual
`{providers:[{gatewayId,token,expiresAt}]}` shape. Work tokens retain the `lpg1`
prefix, and signed claims bind them to product `work`, a gateway, a device, and
its current enrollment session. Code and Work tokens cannot cross product
routes. Work uses `/v1/work/provider-gateway/:gatewayId/:route/*`.

Each Work gateway request checks live device membership, device/session
revocation, Work enablement, provider assignment, exact model allowlist, and
provider protocol. An active stream aborts on client disconnect, and rechecks
authority after PostgreSQL policy/session notifications with a two-second
reauthorization polling fallback. Code gateway forwarding retains its prior
behavior. Upstream provider billing may include tokens generated before an abort
reaches the provider.

## Inventory, usage, and audit metadata

`PUT /v1/desktop/work/inventory` stores a separate Work inventory report. Existing
Code inventory is not replaced. Device responses add `workInventory`. Inventory
contains extension/provider identity and enablement metadata. Free-form sync
errors are replaced with a generic failure label before persistence.

`POST /v1/desktop/work/usage` accepts `DesktopWorkUsageSnapshotBatch`, the existing
absolute-counter snapshot batch plus `enrolledAt`. Its source is immutably bound
to organization, member principal, collection epoch, product, and enrollment
window. Existing sources migrate to product `code`. Analytics and CSV requests
accept `product=work`; omitted product continues to mean Code. Retention,
collection/visibility settings, anonymization, and deletion retain the existing
organization lifecycle and apply across products.

The desktop must capture enterprise attribution at the start of each eligible
Work attempt and aggregate only those attributed counters. Earlier personal
turns, including those earlier on the same UTC date, must never be included.
The server rejects stale epochs, enrollment windows predating the current
collection window, earlier dates, and source rebinding. Daily totals alone
cannot prove that a desktop did not include same-day personal history; this
boundary also requires the desktop attribution implementation and its tests.

`POST /v1/desktop/work/audit` accepts an `events` array of strict
`DesktopWorkAuditEvent` objects. Allowed actions are turn started/completed/
cancelled/failed, tool approved/denied, and policy applied. Fields are event UUID,
occurrence timestamp, policy revision, and optional provider/model IDs. Unknown
fields such as prompts, tool arguments, file paths, or outputs are rejected.
RFC3339 timestamps accept UTC offsets, including Chrono's `+00:00`. Model IDs
use the same bounded printable-128 validator as Work assignments.
Events are deduplicated per device and event UUID.

## Validation performed

Backend TypeScript checking and ESLint passed. On 2026-10-09, the complete API
suite passed against an isolated PostgreSQL 17 database: 22 test files and 149
tests, with team and usage integration flags enabled. Work tests cover grant
union and exclusions, independent model lists, revision conflicts, team and
tenant authorization, malformed authority, gateway product/session revocation,
stream cancellation, consistent bootstrap/ETags, product usage/source binding,
inventory separation, and strict idempotent audit metadata. A checked-in golden
fixture generated by a real Rust Chrono/serde_json program exercises the HTTP API
with `+00:00` timestamps, `model+fast`, and exclusive input/cache counters; its
reproducible generator is beside the JSON under `src/auth/fixtures/`.

No live upstream provider or packaged desktop qualification was performed by
these backend tests. This change does not implement cloud Work execution,
content storage, billing, monetary budgets, SSO, or device-management enforcement.

## Follow-up source review

Later source-only hardening addresses canonical team identity across policy
updates, consistent database snapshots, stream cleanup, final usage reporting
after Work is disabled, and metadata session revalidation. Migration `022`
binds Work usage sources to their original enrolled device. Dashboard requests
ignore superseded responses and preserve the selected product/member scope.

These backend follow-up changes, including migration `022`, were subsequently
exercised in the isolated PostgreSQL integration suite during the dashboard UI
pass below. This does not qualify signed desktop packages or live providers.

## Work dashboard configuration

The Work area separates access, provider/model setup, and plugin/skill
assignments. Members receive read-only effective-access summaries; organization,
team, and member editors retain their respective authority scopes. Organization
catalog decisions distinguish Member choice (no explicit decision), Assigned,
and Blocked. Team grants and individual overrides retain the existing hierarchy.

Organization administrators can configure company keys inside Work using
`GET/POST /v1/admin/work/provider-gateways` and
`PATCH /v1/admin/work/provider-gateways/:gatewayId`. These responses contain
public connection metadata only. POST accepts provider ID, API key, request
limit, and expected revision. PATCH updates key and/or request limit. New
Work-created connections start with no Code models; updates preserve existing
Code model settings. Keys and request limits remain shared across products.
Saving a connection does not verify an upstream key or assign Work model access.

Work forms bound requests to 20 seconds, preserve policy drafts on errors, and
require explicit review before merging local edits with a newer policy. Key-save
responses with unknown outcomes require reloading connection status instead of
automatic replay. Secrets are cleared from the input on submission and are not
echoed in errors. Plugin assignments do not authenticate a member's account.

Validation for this UI pass: 157 API tests (including isolated PostgreSQL
integration), 115 web tests, TypeScript checks, and ESLint passed. Browser checks
used synthetic data for admin saves, connection setup, model assignments,
conflict recovery, provider-error states, disabled members, keyboard tabs,
mobile layouts, and light/dark themes. Live organization settings and provider
keys were not changed. No release build or installer was generated.
