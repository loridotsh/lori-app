# Lori desktop enrollment protocol v1

This document is the implementation boundary between Lori Enterprise and Lori
Desktop. The enterprise API and browser approval surface live in this
repository; the companion desktop client lives in the separate Lori Desktop
repository.

The desktop implementation lives under `src-tauri/src/enterprise/` in that
repository. It stores only non-secret connection and policy metadata in Lori
SQLite and stores rotating device credentials in the operating-system
credential store. The member-facing surface is Settings → Organization.

On macOS, a `tauri dev` executable receives a new ad-hoc code identity whenever
it is rebuilt. Keychain therefore cannot grant stable access without repeatedly
prompting the developer. macOS debug builds use
`~/.lori/enterprise/development-session.json` instead, created atomically with
user-only directory (`0700`) and file (`0600`) permissions. Signed release builds
never use this development fallback and continue to store credentials only in
Keychain.

## Security invariants

- The organization origin is an absolute `https://` URL in production and must
  be treated as the canonical server for the connection.
- The browser URL carries a PKCE challenge and random state, never a password,
  authorization code, access token, or refresh token.
- The `lori://` return carries only a five-minute, single-use authorization
  code, canonical server origin, protocol version, and the original state.
- The authorization code is useful only with the verifier retained by the Lori
  process that initiated the request.
- Lori must compare state in constant time, reject a changed server origin, and
  exchange the code only with the exact canonical origin.
- In signed release builds, access and refresh tokens must be stored in the
  operating-system keychain, never Lori SQLite, logs, crash reports, or CLI
  configuration. The explicit macOS debug-only exception is described above.

## Desktop initiation

The browser may first open Lori with:

```text
lori://connect?server=https%3A%2F%2Flori.acme.com&protocol=1
```

This link contains only the organization origin. Lori must show the origin,
bring its Organization surface forward, and create a fresh request
automatically. The deliberate security action remains the browser approval;
the launch link never carries a session, invitation token, authorization code,
access token, or refresh token. Lori does not expose manual organization-origin
entry: the dashboard is the only initiation surface.

The `server` value is generated from the deployment's canonical `LORI_ADDRESS`,
so a custom domain works without discovery or hard-coded vendor infrastructure.
Only the debug-build approval return uses a random loopback listener; production
launch and enrollment remain pinned to the configured HTTPS origin.

Lori generates:

- `verifier`: 43–128 characters from the RFC 7636 unreserved character set;
- `challenge`: `BASE64URL(SHA256(ASCII(verifier)))`; and
- `state`: at least 128 bits of cryptographic randomness, base64url encoded.

It opens:

```text
https://lori.acme.com/connect
  ?challenge={challenge}
  &state={state}
  &device_name={url-encoded display name}
  &platform={macos|windows|linux}
  &app_version={version}
```

If the member is signed out, Lori Enterprise sends them through `/sign-in` and
returns them to the same validated request. The approval page shows the signed-in
account, organization, device name, platform, app version, requested access,
and a short fingerprint derived from the PKCE challenge. Signing in confirms the
member account but does not trust a new desktop installation: the page clearly
labels the remaining one-time device approval. A Lori installation that is
already connected to the same canonical organization skips this approval and
shows an already-connected confirmation instead.

## Browser authorization

After explicit approval, the browser sends:

```http
POST /api/v1/enrollment/authorize
Content-Type: application/json

{
  "appVersion": "1.2.3",
  "codeChallenge": "...",
  "deviceName": "Ashish's MacBook Pro",
  "platform": "macos",
  "state": "..."
}
```

The browser receives a `lori://enroll` deep link and opens it. Normal browser
mutation protections apply: an authenticated membership, mandatory exact
trusted Origin (or parsed same-origin Referer fallback), same-origin cookies,
and rate limiting.

## Code exchange

The deep-link handler must validate `protocol=1`, `state`, and the exact server
origin before posting:

```http
POST https://lori.acme.com/api/v1/enrollment/token
Content-Type: application/json

{
  "code": "lec_...",
  "codeVerifier": "...",
  "protocolVersion": 1
}
```

The code expires after five minutes and is consumed once under a database lock.
The response uses `Cache-Control: no-store`:

```json
{
  "accessToken": "lea_...",
  "deviceId": "uuid",
  "expiresIn": 900,
  "refreshExpiresIn": 2592000,
  "refreshToken": "ler_...",
  "tokenType": "Bearer"
}
```

Lori should overwrite the keychain refresh token atomically before discarding
the previous value.

## Bootstrap and policy synchronization

Lori reads its effective identity and policy with:

```http
GET /api/v1/desktop/bootstrap
Authorization: Bearer lea_...
X-Lori-Protocol-Version: 1
If-None-Match: "lori-policy-v1-4"
```

The response identifies the server, organization, member, optional team
summaries, device, policy revision, and managed catalog list. A matching ETag
returns `304`.

`policy.personalInstallationAttribution` identifies why each effective
personal-installation decision won: organization policy, one or more named
teams, or a global member override. Desktop persists this attribution with the
effective policy and displays it alongside team membership. Attribution never
replaces enforcement; it explains the already-resolved boolean.

`policy.managedCatalogAttribution` provides the same explanation per catalog
item, including all contributing teams, organization assignment state, and any
winning global member override. Desktop stores it independently from the
enforced `managedCatalog` list and uses it only to explain why managed items are
available.

`personalInstallations.plugins`, `personalInstallations.providers`, and
`personalInstallations.skills` are enforced independently. `false` means the
enterprise-bound Lori experience must block new personal configuration and keep
existing personal items inactive. It must not delete member-owned files.

`managedCatalog` contains the authenticated member's effective app, plugin,
skill, and provider decisions after organization assignments and the member's
effective team contributions are unioned, followed by global member overrides.
Organization and team entries are positive assignments. A team-member override
changes only that team's contribution. An item absent from the effective list
follows its effective personal category. A global member override with
`enabled: false` explicitly blocks that item even when an organization or team
assigns it or its personal category is otherwise allowed.

Lori records organization-managed provenance separately from ordinary personal
installs. Reconciliation is bidirectional:

- assignment installs or repairs the bundled definition, marks it
  organization-managed, and enables it in the effective agent configuration;
- unassignment with the personal category blocked disables the local record,
  hides the retired managed item from marketplace lists, and prunes its Lori
  CLI entry or skill symlink;
- unassignment with the personal category allowed keeps the local item enabled
  as a personal fallback, clears organization ownership, and removes the
  Organization badge so later member toggles remain authoritative; and
- no policy transition deletes the local skill directory or member-owned
  configuration.

An explicitly blocked global member override still wins over organization and
team assignments and over a personal-category allow. Lori refreshes the
bootstrap at startup and on demand from **Refresh policy**. While connected it
also holds an authenticated, bounded long poll at
`GET /api/v1/desktop/updates?afterRevision=<revision>`. PostgreSQL commit
notifications fan policy revisions and device revocations out across every API
replica, so Lori reconciles an administrator change immediately without a
manual refresh. Each wait expires after 25 seconds and is reauthenticated; the
existing one-minute ETag poll remains as a recovery path for older servers,
listener restarts, proxy interruptions, or missed notifications.

The update endpoint carries no policy or credential data. It returns only a
new revision or an access-revoked signal, after which Lori uses the normal
bootstrap/refresh contract. This keeps policy resolution authoritative on the
server and preserves token rotation, ETag validation, and non-destructive local
reconciliation.

## Refresh, disconnect, and revocation

Refresh before the access token expires:

```http
POST /api/v1/enrollment/refresh
Content-Type: application/json

{
  "protocolVersion": 1,
  "refreshToken": "ler_..."
}
```

Every successful refresh returns a new access token and refresh token. Reuse of
an already-consumed refresh token revokes the entire token family. A failed
atomic keychain update should therefore require a fresh browser enrollment
rather than retrying an older refresh token indefinitely.

The desktop can disconnect itself with:

```http
POST /api/v1/desktop/disconnect
Authorization: Bearer lea_...
X-Lori-Protocol-Version: 1
```

On success, Lori removes the device credential and saved organization
connection before reporting the installation as disconnected. Rewriting each
supported coding tool back to the member's personal marketplace and provider
configuration continues in the background, so the Organization screen does
not remain blocked on filesystem work. Those writes still use Lori's shared CLI
configuration lock and never delete the member's saved personal data.

If the server cannot confirm revocation, Lori keeps the connection visible and
offers a separate local-removal fallback. That fallback is explicit because the
device can remain listed in the dashboard until an administrator revokes it.
An already-revoked device can be removed locally without another server call.

Members can revoke their own installations in `/devices`; administrators can
revoke any organization installation. Removing a member revokes browser and
device sessions in the same transaction. A committed device or token-family
revocation wakes that installation's update wait immediately; another device
in the same organization is not disturbed.

## Required desktop states

The desktop implementation should distinguish:

- not connected;
- waiting for browser;
- exchange in progress;
- connected and policy current;
- temporarily offline with a cached, unexpired policy;
- access token expired and refresh in progress;
- organization access revoked;
- protocol upgrade required;
- server identity changed; and
- re-enrollment required after refresh replay or keychain loss.

Network failure must not be presented as revocation. Conversely, an explicit
401/403 from refresh or bootstrap must clear usable in-memory credentials,
retain only non-secret diagnostic metadata, and return Lori to a reconnect
state.

## Local end-to-end test

Start Lori Enterprise from one terminal:

```bash
npm install
npm run dev
```

Start Lori Desktop from the root of a separate Lori Desktop checkout in another
terminal:

```bash
npm install
npm run tauri dev
```

Sign in to the development dashboard at `http://localhost:3000` and choose
**Open Lori desktop**. The already-running Lori development process receives the
canonical organization origin automatically, and the newly opened browser tab
continues to the approval page for a new installation. An installation already
connected to that origin receives an immediate confirmation instead. Approve a
new displayed device and return to Lori. The Organization panel should show the
company, member, device, policy revision, effective personal app/plugin,
provider, and skill rules, and the number of managed catalog assignments.

An unpackaged `tauri dev` binary cannot register a custom URL scheme with macOS
LaunchServices. When the Enterprise web app runs in development, its Open Lori
button therefore targets a development-only listener at
`http://127.0.0.1:43891/connect`. The listener accepts only loopback connections,
requires the exact local Host and strict `server`/`protocol` parameters, and
redirects that browser tab to the PKCE approval URL. It never receives a web
session, password, invitation, authorization code, access token, or refresh
token. The request reader remains size-bounded while allowing normal browser
headers and localhost cookies; oversized requests receive a specific recovery
message instead of being mislabeled as incomplete. Browsers may create idle
speculative localhost connections before the real navigation. The listener
handles connections independently and closes incomplete speculative sockets
silently, so they cannot block the real dashboard request or create a false
error page. Release builds do not start this listener and continue to use
`lori://connect`.

After approval, a debug build creates a separate random, short-lived callback
on `127.0.0.1` for the PKCE-bound authorization code and completes enrollment
automatically. That callback accepts only the active request and stops after one
valid return or ten minutes. Its browser completion page reports success only
after the code exchange, bootstrap, credential persistence, and local policy
reconciliation finish. If setup cannot finish, the browser shows a non-secret
attention state while Lori retains the actionable error and any recoverable
connection state for retry.

If a local firewall or browser policy blocks the loopback return, choose
**Copy return link** on the approval page and deliver it to the
already-running dev process:

```bash
./src-tauri/target/debug/lori 'PASTE_THE_LORI_RETURN_LINK_HERE'
```

The second process exits after securely forwarding the link to the running Lori
instance. Installed `.app` and `.dmg` builds open `lori://` directly. If port
`43891` is already occupied, Lori development startup fails with a precise
handoff-listener error instead of silently leaving the dashboard button broken.

For an invite-driven test, choose **Open Lori desktop** after member onboarding.
Lori must display the received server origin and open the PKCE-bound browser
approval automatically. Approving the named device in the browser remains
required for a new installation. Reopening the same link while a matching
approval is pending must reuse the active request instead of invalidating it.
Once the installation is connected, choosing **Open Lori desktop** again must
confirm that no additional approval is needed. Opening a different
organization's link must fail with a clear disconnect-first message.

Disconnect from the Organization panel or revoke the device from the enterprise
Devices page. A refresh after revocation must show **Access revoked**. Offline
testing must retain cached policy and personal files; it must not report
revocation unless the server explicitly rejects the credentials.
