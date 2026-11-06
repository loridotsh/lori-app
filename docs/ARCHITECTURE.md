# Architecture and product boundaries

## Deployment invariant

One Lori Enterprise deployment represents exactly one company. The public
origin, such as `https://lori.acme.com`, is the canonical organization address.
Admins and IT configure it. Members receive it through an invitation and do not
type or select a server in normal use.

```text
Internet
   │  :80 / :443
   ▼
Caddy edge
   ├── /api/* ──► TypeScript API ──► PostgreSQL
   └── /*      ──► Next.js dashboard
```

PostgreSQL, the API, and the dashboard have no published host ports. Caddy
provides a same-origin boundary so browser sessions do not require broad CORS
rules.

## Browser identity contract

Identity v1 uses email/password accounts, invite-only by default. Better Auth owns password
hashes, browser sessions, origin validation, and rate limiting. The API wraps
organization mutations so a deployment can expose only `admin` and `member`.
Team membership adds a separate resource-scoped `team_admin` role; it never
widens the member's organization role.

The first administrator claims a high-entropy Docker-generated setup token,
creates the only organization, and permanently completes deployment setup.
Afterward, every registration requires a short-lived signed onboarding cookie
bound to either that setup claim or a live invitation and the submitted email.

Invitation URLs carry 256-bit opaque tokens. Only SHA-256 hashes are stored.
Links expire after seven days, are single-use, and are regenerated rather than
retrieved. Regeneration invalidates the previous token.

`LORI_PUBLIC_SIGNUP` runs one deployment as a hosted cloud instead. Anyone can
then create an individual or enterprise account without a setup token, and each
account is a separate tenant. An individual is a one-person organization, and an
enterprise can invite an existing individual, who keeps their own workspace.

## Desktop enrollment contract

Enrollment protocol v1 is implemented by this enterprise package:

1. An administrator creates an email-bound invitation and delivers the copied
   link out of band.
2. The member joins the organization and signs in in their browser.
3. Lori desktop generates a PKCE verifier/challenge and state value, then opens
   `https://lori.acme.com/connect?...`.
4. The member deliberately approves the named Lori installation.
5. The server issues a five-minute, single-use authorization code bound to the
   company, member, device metadata, and desktop PKCE challenge.
6. The browser redirects to
   `lori://enroll?server=https%3A%2F%2Flori.acme.com&code={code}&protocol=1&state={state}`.
7. Lori verifies the returned state and canonical HTTPS origin, then exchanges
   the code and PKCE verifier directly with the server.
8. The authorization code is consumed atomically and the desktop receives its
   own 15-minute access token plus a rotating 30-day refresh token.

Access and refresh tokens must not be embedded in the browser URL or the
`lori://` deep link. Invite tokens, authorization codes, access tokens, and
refresh tokens are stored only as keyed hashes. Refresh-token replay revokes the
entire device token family. Device and membership revocation immediately deny
refresh and bootstrap requests.

Committed changes to the organization policy revision are published through a
PostgreSQL `LISTEN`/`NOTIFY` channel. Each API replica uses one listener and
fans the signal out to authenticated, 25-second desktop long polls; device
revocations are targeted to the affected installation. Lori then fetches the
authoritative bootstrap and applies the same non-destructive reconciliation as
a manual refresh. A one-minute ETag poll remains the delivery safety net, so a
listener or proxy failure cannot strand a device on stale policy.

The desktop-side deep-link and loopback handlers, policy client, and release
OS-keychain persistence live under `src-tauri/src/enterprise/` in the separate
Lori Desktop repository. The exact
cross-repository implementation contract is documented in
[DESKTOP_ENROLLMENT.md](DESKTOP_ENROLLMENT.md).

## Organization, team, and member policy

Every organization has a monotonically revisioned default policy. New
deployments deny personal configuration by default. Administrators may
independently allow:

- personal apps and MCP plugins; and
- personal cloud or local AI providers; and
- personal skills.

The managed catalog contains the Lori release's apps, MCP plugins, skills, and
providers. Organization rows are positive assignments: an assigned item remains
available even when that personal category is blocked, while an unassigned item
continues to follow the effective personal-installation boundary.

Members may belong to multiple teams. Team catalog assignments are positive and
combine additively with organization assignments and assignments from every
other team. Personal-installation grants use the same least-restrictive rule:
the organization or any effective team contribution may allow the category. A
team-member override changes only that team's contribution, so it cannot revoke
access supplied by the organization or another team.

Global member overrides are tri-state: inherit, allow, or block, and resolve
last. An explicit global member block therefore wins over organization and team
assignments and over an allowed personal category. Team creation, membership,
roles, policy, team-member exceptions, and global member mutations all advance
the single organization revision so device ETags cannot remain stale.

The effective policy also carries source attribution for each personal category
and managed-catalog decision: `organization`, `team` (with the granting teams),
or `member_override`. This metadata is explanatory only—the effective booleans
and catalog decisions remain the enforcement contract—but it prevents an
additive team setting from being mistaken for a deny. Bootstrap-shape migrations
advance organization revisions, and the desktop clears its stored ETag when its
local attribution schema changes, so upgraded clients receive the new metadata
even when the underlying access decision did not change.

When a capability is denied, Lori desktop must block new personal installs and
keep personal items inactive in the enterprise-bound experience. Enforcement
must not silently delete member-owned files; it should preserve them locally so
an administrator can later re-enable the capability without data loss.
Desktop marketplace records carry explicit organization-managed provenance.
Reconciliation is bidirectional: newly assigned items are provisioned and
enabled, while removed assignments are disabled and removed from agent CLI
configuration when the personal category is blocked. If that category is
allowed, the local item remains available as a personal fallback. The current
effective assignment—not historical provenance—drives the Organization badge.
The fallback transition clears organization ownership once so subsequent member
toggles are not overwritten by future policy polls.
Catalog and personal-boundary mutations validate against the bundled release
catalog, require an organization administrator or the relevant scoped team
administrator on every request, use optimistic concurrency, and produce
append-only audit events. Team creation and deletion remain organization-admin
operations.

## Company-managed AI providers

An organization administrator can connect a supported cloud provider in the
dashboard and choose its allowed models and per-device request limit. The
upstream API key is encrypted in Enterprise and is never delivered to a Lori
desktop or coding tool. A provider must also be assigned through the effective
catalog policy before it appears for a member.

```text
Admin stores provider key
  → Enterprise encrypts it at rest
  → current effective provider assignment is evaluated
  → Lori desktop receives gateway metadata plus a short-lived device credential
  → coding tool calls the fixed Enterprise gateway URL
  → Enterprise re-checks the device, member, policy, model, and limit
  → Enterprise adds the upstream key and forwards an allowed request
```

The gateway is intentionally narrow: administrators cannot supply arbitrary
upstream URLs, the API exposes only the supported provider endpoint subset, and
the server does not claim centralized provider billing or spend budgets. A direct
third-party CLI that Lori does not configure is not automatically granted this
access; it has no upstream key and no short-lived gateway credential. In Lori,
the desktop provider view marks these entries as **Company-managed** and keeps
their credentials, models, and coding-tool assignments read-only.

## First-admin bootstrap

There must be no permanent default administrator or shared dashboard password.
The identity phase should use a one-time bootstrap capability that:

- is generated during deployment and readable only by the operator;
- expires after the first organization owner is established;
- requires the administrator to create an email/password account;
- cannot be recreated through a public unauthenticated endpoint; and
- records completion in the audit trail.

The setup token is held in the private Docker secrets volume. Operators retrieve
it explicitly with the `setup-token` utility service; normal startup never logs
it.

## Storage contract

PostgreSQL is the only product database. Migrations are ordered SQL files,
checksummed after application, and serialized with an advisory lock. Services
start in this order:

```text
secret bootstrap → PostgreSQL health → migrations → API health → web → edge
```

The API owns database access. The Next.js dashboard never connects to
PostgreSQL directly.

## Capability sequence

1. **Identity and enrollment:** email/password identity, people, roles,
   email-bound invitations, device enrollment, revocation, and policy delivery.
2. **AI gateway:** the secure company-provider core is implemented: encrypted
   upstream keys, fixed catalog origins, short-lived device credentials,
   current-policy enforcement, model allowlists, per-device request limits, and
   audit events. Central provider budgets, broad provider endpoint coverage,
   and advanced retention controls remain future work.
3. **Catalog governance:** organization assignment, unassignment, personal
   boundaries, and member overrides are implemented for the bundled catalog;
   private catalog publishing workflows remain future work.
4. **Usage analytics:** organization usage collection, admin visibility settings,
   and dashboard reporting are implemented; provider billing budgets and external
   telemetry export contracts remain future work.
5. **Desktop policy sync:** long-poll and ETag policy delivery to enrolled
   desktops (see enrollment and gateway sections above).

These phases are product acceptance boundaries, not navigation placeholders.
Every capability should remain disabled until its backend authorization,
storage, audit, UI states, and desktop protocol are implemented together.
