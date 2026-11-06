# Enterprise Cloud Projects

Projects are organization-owned Cloud Work scopes. Direct and team grants are combined, then explicit blocks and action restrictions are applied. Project readers share conversations, files, and memory; use another project for a different confidentiality boundary. Existing private Cloud, Local Work, and Code remain separate.

## Implementation map

- `packages/contracts/src/cloud-projects.ts`: canonical project contracts.
- `apps/api/src/cloud/projects`: policy, encrypted persistence, lifecycle, shared memory, lexical recall, and routes.
- `apps/api/migrations/034_cloud_projects.sql`: additive scope columns, parent checks, project RLS, encrypted-content guards, and metadata-only maintenance directories.
- Existing Cloud service/files/rounds/tools/extensions retain the agent runtime and enforce the verified parent scope.
- `apps/web/src/components/work/cloud/projects`: expandable member navigation, scoped settings, grants, memory, and policy controls.
- `apps/web/src/app/work/projects`: card overview and dedicated detail routes beneath Work in Manage. Admins see organization inventory; members see only explicitly shared projects and permitted controls. `/projects` redirects old links. Governance does not grant conversation or file access.
- Desktop `src-tauri/src/work/projects`: allowlisted enrolled transport and OS-secured drafts. `src/work/projects`: member interface. Project content is not mirrored into local workspace/history storage.

A hidden root conversation anchors the project's single Files area. A regular conversation's deletion does not delete shared files. Creators are attribution, and each run records its actual initiating member.

## Authority and resources (migration 041)

- Organization Owners and Admins hold full access to every shared project (`access.source = "organization_admin"`) without grants or temporary access requests. Member blocks and grant restrictions do not reduce it; the project's safety controls (exports, external writes, memory) and lifecycle still apply to everyone. Personal projects and private chats stay private.
- Models, plugins, and skills each have a mode (`resolveProjectPolicy` in contracts). `inherit` uses each member's Work access. `assigned` makes exactly the listed resources usable inside the project, without a general assignment, bounded by organization approval (Work → Team delegation plus defaults) and a member's explicit restrictions. Project assignments never apply in private chats or unscoped desktop requests. Policies saved before 041 read a nonempty list as an assignment; writing a nonempty list without modes is refused with `project_policy_upgrade_required`.
- One resolver (`apps/api/src/auth/work-resources.ts`) decides capabilities, submission, worker claims and leases, revocation sweeps, plugins, skills, and the effective-access preview.

## Enablement and rollback

Desktop integration has a separate default-off gate:
`WORK_CLOUD_DESKTOP_PROJECTS_ENABLED=true`. It requires the existing project
enablement, keys, restricted runtime role, and compatible workers. Browser project
availability is independent of this flag. Enrolled project requests require
`X-Lori-Project-Client-Version: 1`; matched web proxies forward that header for
ordinary and SSE requests. An old desktop can continue private Cloud while its
project operations are refused. Keep the desktop flag off in production until
packaged/native acceptance is complete; staging enablement is for qualification.

`WORK_CLOUD_PROJECTS_ENABLED` defaults to false. Keep it false until the release gates below pass. Deploy matched contracts, API, worker, web, and desktop builds. Workers must advertise `projectScopes`; old workers can continue private runs only.

Apply migrations with the migration-owner credential. Then run `node apps/api/dist/db/provision-runtime.js` with `DATABASE_RUNTIME_USER` and `DATABASE_RUNTIME_PASSWORD_FILE`. The API receives the restricted runtime credential, never the migration-owner credential. Compose provisions and mounts separate runtime and project-key secret volumes. Readiness rejects superuser, bypass-RLS, administrative, or table-owning roles. The analytics partition function alone runs with owner authority and a schema-bound search path.

Set `WORK_CLOUD_PROJECT_KEYS_FILE` to a dedicated mounted JSON keyring:

```json
{"active":"version-name","keys":{"version-name":"32-random-bytes-as-canonical-base64url"}}
```

Generate keys using a cryptographic random generator. Do not place keys in Git, logs, browser configuration, worker mounts, or an ordinary application environment dump. The key file must be a regular file, not a symlink, and must not allow world access. Every project has a separate random content key wrapped by this keyring. A stored encrypted probe detects accidental replacement of the mounted keyring and keeps projects unavailable. Never delete that probe to bypass a missing-key failure.

Rollback first disables projects in the compatible build. Migration checksum enforcement rejects unknown migrations in older binaries; downgrading requires a rehearsed compatible migration path or a consistent database/storage/key backup restore.

## Local startup and recovery

Use `npm run dev:cloud` for an established local Projects setup. It reuses the
existing project keys and restricted runtime credentials, verifies storage, and
passes both project flags to the API. Keep local wrapper scripts delegated to
this entry point instead of maintaining a separate service environment. Setting
`WORK_CLOUD_DESKTOP_PROJECTS_ENABLED` only on the desktop process does not enable
desktop project access on the server.

After a restart, verify the authenticated `/api/v1/work/cloud/projects/capabilities`
response includes `available: true` and `desktopAvailable: true`, then verify the
enrolled user's project listing. General readiness alone does not confirm this
feature is enabled. Keep the Enterprise `LORI_ADDRESS` and internal API address
consistent; personal-account and Registry origins are separate configuration.

## Backup, recovery, and wrapping-key rotation

Back up PostgreSQL, private blob storage, and the complete keyring as one recoverable set. Protect key backups separately from database/blob backups. Stop admission and drain workers, or use a tested consistent snapshot procedure. Restore into an isolated environment first, then verify project decryption, file hashes, authorization, and ordinary private Work before admitting traffic. Losing every copy of a content-wrapping key makes its projects unrecoverable.

For rotation, preserve old keys and add a newly generated key under a new version name. During a maintenance window, disable projects and drain project work. Set `active` to the new version, and run the built `apps/api/dist/cloud/projects/key-rotation.js --rewrap` with the migration-owner database credential and the complete keyring file. This command rewraps project keys in bounded transactions, verifies them, and updates the encrypted key probe. It never prints key material. Restart API processes with the complete keyring, verify representative chats/files/memory and restore tests, then re-enable projects. Retain old key versions for backups that still require them. This is wrapping-key rotation; it does not re-encrypt every content record with a new data key.

## Operational behavior

- One API instance is the qualified architecture; do not assume cross-instance locks or stream invalidation are coordinated.
- Project admission is limited to four queued/active runs, alongside existing organization/global limits.
- Shared file edits use immutable versions and hash/revision checks. Conflicts require reloading and reapplying edits.
- Project recall uses bounded MiniSearch snapshots encrypted at rest. Text files up to the extraction bound are indexed; binary documents currently contribute metadata, so indexing reports limited coverage. Document tools remain available for explicit reading. No vector service is required.
- Connector setup requires an explicit dedicated-account acknowledgement. This does not enforce isolation inside a remote provider account. Qualify remote permissions for every enabled connector; do not claim strict remote isolation for an unrestricted remote account.
- Archive permits reading and blocks mutations. Deletion hides content and cancels work; recovery is at most 30 days and never exceeds organization retention. Restore does not revive cancelled runs or approvals.
- Desktop verification failures lock project content. Definitive revocation clears the managed view/drafts; unsent drafts use the OS credential store without a plaintext fallback. Explicit exports remain outside managed revocation.
- Application encryption protects stored content, not an operator controlling the running API and keys. Validate TLS at each external boundary and document internal hops.

## Qualification record — 2026-10-16

### Live browser role qualification — 2026-10-17

Tested the localhost application in the in-app browser with Projects Test Admin
and a dedicated Navigation QA Member. Created only the synthetic project
`Browser QA — roles and navigation` (77490c4c-7b70-445c-a45a-8fbd40514155).
Existing accounts' passwords and existing project grants were not changed.

- Admin: created the project; searched for the QA member; saved and reloaded a
  Contributor grant; verified the sole direct manager cannot be removed.
- Contributor: saw only the granted project and no organization administration;
  project details were read-only; ran real project and private conversations to
  completion with separate synthetic markers and durable message history.
- File workflow: requested browser-qa.txt; observed queued, running, and waiting
  for approval states; approved the proposed new-file change; previewed the exact
  synthetic content. Admin subsequently saw the member's shared contribution.
- Viewer: live downgrade disabled messaging, removed uploads/downloads, and made
  the file preview read-only. The private conversation remained available.
- Manager: saved/reloaded project instructions and saved project memory; no
  organization-admin controls or undelegated membership controls appeared.
- Denials: direct /organization navigation was refused; an ungranted project
  exposed no content; explicit blocking locked the open project; its direct file
  endpoint returned project_not_found. Restoring the grant recovered discovery.
- Role transitions for live-session tests used an independent admin API session
  scoped to this synthetic project, while UI observations remained in the member
  browser. The original grant was saved through the admin UI.

Issues found and fixed: misleading access-denial copy, project 404s being reported
as a server-upgrade requirement, a visible nonfunctional Viewer upload control,
delayed withdrawal after a confirmed project denial, stale project discovery
after restored grants, and shared-message screen-reader attribution saying You
for another contributor. Regression coverage includes denial text, upload gating,
and immediate workspace withdrawal.

The full web suite passed 708 tests. The synthetic account/project, file, memory,
and conversation history remain for inspection; the member grant is Contributor,
no block remains, and the browser was returned to the admin account. Temporary
setup scripts were removed. Real connector OAuth, concurrent multi-device races,
all retention/archive/purge paths, cross-organization browser sessions, desktop
packaging, and backup/restore were not qualified by this browser run.

Recorded local results: 601 API tests passed with 39 skipped; 656 existing web tests passed across the component and loopback-proxy runs, plus two project offline/revocation regressions; 48 focused desktop frontend tests passed; two native project tests and native Clippy passed; 25 worker tests passed with the hardened Linux qualification test ignored on macOS. API and desktop builds passed. The web production build passed using webpack; Turbopack hit an environment process/port restriction. The final focused project suite passed 17 tests. The desktop UI finish review closed all three findings.

Local checks include real PostgreSQL tests using a separately provisioned LOGIN role, project permission/crypto tests, existing Cloud and extension regression suites, web component/proxy tests, desktop TypeScript/build checks, native project tests, worker tests, and synthetic Chromium layout checks. The integration fixture creates and removes its own schema and runtime role; it does not migrate customer data.

The synthetic UI captures verify layout only; they do not establish authenticated multi-user, real-provider, real-OAuth, native keychain, Linux isolation, or disaster-recovery readiness. Before production enablement, record evidence for:

1. Four separate authenticated team members sharing chats/files/memory; an unrelated team and another organization cannot discover them.
2. Actual provider streaming, manager/initiator approvals, concurrent file conflicts, live session/team revocation, and network-loss recovery on web and packaged desktop.
3. Real dedicated connector OAuth accounts, token refresh/revocation, and remote resource restrictions.
4. Hardened Linux worker tests, conversion tools, container restart/termination, and capacity/backpressure.
5. Consistent restore and wrapping-key rotation on deployment-equivalent storage; expiry and complete purge of database rows/blobs/indexes/jobs.
6. Platform keychain behavior, account switching, encrypted-draft failures, and packaged desktop regression on supported systems.

Do not enable the feature solely because local suites pass. Record skipped tests and environment-dependent gates explicitly.

## Management follow-up verification

The Manage Projects page replaces the Work management dialogs. Normal chats remain
visible outside project groups; clicking a project title toggles it. Permission
controls include project model, plugin, and skill assignments, delegated access and
connection management, member blocks, and effective-access previews. Connection
inventory has an explicit management mode checked by the same server policy layer;
query flags do not grant authority. Grant and block audit events now include the
structural changes, and policy updates record before/after restrictions without
recording instructions or credentials.

The follow-up passed 602 API tests (39 skipped) and 672 web tests. Added real-PG
coverage verifies that team-admin status grants no project authority, delegated
managers cannot remove administrator restrictions or change project policy, and
explicit blocks remove management and content access. Local browser checks cover
title disclosure, private-chat placement, Manage navigation, policy catalogs, and
project connection inventory. Existing live-provider/OAuth, restore, packaged
desktop, and hardened-Linux release gates remain in force.

## Project overview navigation — 2026-10-17

Projects now sits beneath Work in Manage. `/work/projects` shows the authorized
project cards; `/work/projects/[projectId]` opens a dedicated detail page. Legacy
`/projects?project=...` URLs redirect to the equivalent detail route. Admins retain
organization inventory, while ordinary members can browse explicitly shared
projects with capability-shaped configuration controls. Discovery follows filtered
pagination before hiding the navigation entry, and Work-disabled members remain
excluded. The web regression run passed 678 tests; additional focused tests cover
viewer read-only fields, delegated action boundaries, and filtered discovery.

## Work management discovery and selectors — 2026-10-17

### Navigation continuity and conversation activity

The later navigation review moved the management shell to the root layout so
Access, Work, Projects, and other management destinations share the same sidebar.
Leaf pages publish their current viewer, breadcrumb, and width to that shell;
authentication and authorization remain in the existing page/API boundaries.
Global route scrolling is immediate with a stable scrollbar gutter. Manual Work
group expansion is no longer reset by changing the selected page.

Scope transitions now prepare capabilities, the requested conversation, and files
before committing, avoiding an intermediate New conversation or loading screen.
Editors remain scope-owned. Sidebar scroll restoration uses a stable callback
and runs on mount rather than every render. Private history has the same spacing
inside and outside project view. Browser measurements confirmed equal management
sidebar bounds between Work and Access, and equal conversation-history height,
content height, and project offset between private and project views. Mobile
scope selection closed the drawer correctly; the browser reported no errors.
Final verification: 705 web tests passed, along with TypeScript and scoped lint.

Private/project scope changes now authorize the destination and fetch fresh
expanded navigation pages before committing the switch. The prior workspace
stays mounted and inert while this runs; a failed destination request leaves its
scope and URL unchanged. Successful transitions still remount scope-owned editor
state, preventing drafts, files, and tools from carrying into another project.
Navigation presentation alone survives: width, collapse, desktop scroll, and
expanded history. Desktop and mobile history expansion are tracked separately.
Background refreshes no longer put the More button into a loading state.
The 2026-10-17 follow-up passed 703 web tests, TypeScript, and scoped lint, plus
browser private/project round trips, expanded-history retention, and mobile
drawer selection. No provider calls or permission mutations were performed.

Work management shares a persistent layout so navigation, account controls, and
the sidebar remain mounted during route loading. Leaf pages continue to own
authentication, authorization, and return URLs. Cloud Work retains its own shell.
Project conversation rows retain their layout during background verification;
explicit collapse, offline access, or failed verification still withdraw content.
Conversation list responses include the latest run status through the existing
authorized scope. Sidebar markers distinguish queued, running, awaiting approval,
failed, and interrupted runs. Five-second list refreshes reconcile activity in
other conversations; the selected run also uses its existing event stream.

Qualification: 701 web tests and 10 restricted-role PostgreSQL project integration
tests passed. Web/API TypeScript and scoped lint passed. Browser checks exercised
Manage Work/Projects switching and existing project conversation selection without
provider calls or policy changes. This does not qualify live-provider execution or
all deployment environments.

The Work navigation parent is now an expandable group, with direct links to
access policy, providers/models, plugins/skills, authorized projects and usage,
and workspace execution. Ordinary members see their own Work access; an explicit
Work-disabled state disables workspace launch and continues to hide Projects.

Project membership, creation delegation, roles, blocks, and permission-preview
selectors share an app-rendered searchable picker. It supports grouped choices,
email search, disabled duplicate entries, keyboard selection, Escape restoration,
Tab continuation, viewport constraints, and withdrawal under a parent access lock.
Permission changes remain staged until Save. The UI now explains and prevents
violations of the server's existing last-direct-manager rule. No server-side
permission ceiling was relaxed.

The full web run passed 692 tests, followed by focused keyboard and access-control
checks. TypeScript, lint, and the production webpack build passed. Live browser
checks verified searchable results, correct Tab focus, and narrow-screen popup
containment without changing saved memberships or organization policy.
