# Security notes

This package includes the first browser identity boundary. Deferred enterprise
modules remain disabled until their own security contracts are implemented.

## Current controls

- Caddy is the only service with published ports.
- The PostgreSQL password is generated with cryptographic randomness on first
  start and stored in a Docker volume mounted read-only into consumers.
- Application containers run as non-root, with a read-only root filesystem,
  `no-new-privileges`, and all Linux capabilities dropped.
- API logging redacts authorization, `x-api-key`, cookie, and `set-cookie`
  headers.
- Better Auth stores password hashes and database-backed sessions, validates
  trusted origins, and rate-limits authentication requests.
- Browser session and cookie mutations fail closed unless the request carries
  the exact deployment Origin or a same-origin Referer fallback. Desktop
  PKCE/token and bearer-authenticated routes do not depend on browser cookies.
- Public registration is denied without a signed setup or invitation claim.
- Invitation secrets are hashed, expire after seven days, and are single-use.
- Admin/member authorization is deny-by-default in custom organization APIs.
- The final administrator cannot be removed or demoted.
- Removing a member revokes every active session.
- Desktop enrollment uses a five-minute, single-use code bound to the Lori
  desktop request with PKCE S256.
- Device access tokens expire after 15 minutes. Thirty-day refresh tokens rotate
  on every use; replay revokes the token family.
- Authorization codes, device access tokens, and refresh tokens are retained
  only as HMAC-SHA-256 hashes.
- Device, session, and membership revocation are checked on every desktop
  bootstrap or credential refresh.
- Organization policy is versioned with optimistic concurrency, audited, and
  denies personal installations and provider configuration by default.
- Organization-owned cloud-provider keys are encrypted with AES-256-GCM before
  they enter PostgreSQL. Ciphertext is bound to its organization and provider,
  and the encryption/signing key lives only in the private Docker secrets
  volume; it is never returned to the dashboard, desktop, audit log, or API
  log.
- Lori desktop receives a separate short-lived, device- and gateway-scoped
  credential (currently 12 hours) rather than the upstream key. The API checks
  its signature and expiry, current device and membership state, and current
  effective organization/team/member provider policy for every proxied request.
  Removing an assignment, revoking a device, removing a member, or deleting a
  company connection therefore denies an already-configured coding tool on its
  next request.
- Provider proxying uses only fixed HTTPS upstream origins from the bundled
  catalog and a small allowlist of provider API paths. It accepts only enabled
  model IDs, applies a per-device/per-provider request limit, forwards a small
  allowlist of safe request headers, rejects credential-bearing query
  parameters, and does not expose the upstream key to Lori desktop or coding
  tools. Caddy omits request URIs and sensitive credential headers from access
  logs as a defense in depth.
- Catalog items are validated against the immutable catalog snapshot shipped
  with the server. Organization catalog rows are positive assignments;
  unassigned items follow the effective personal-installation boundary.
  Per-member overrides are organization-scoped and may explicitly grant or deny
  one item.
- Lori preserves blocked personal configuration locally but removes it from
  effective CLI synchronization and launch environments. Organization-managed
  provenance is stored separately from member-owned installs so unassignment
  can disable and hide only the managed surface without deleting local files.
  Policy refresh runs at startup, on demand, and every minute while a credential
  remains valid.
- Identity mutations produce append-only security audit events.
- Readiness depends on a real database query; liveness does not.
- Migrations are immutable after application and serialized across deploys.
- The dashboard sends `noindex` metadata and Caddy sets conservative browser
  security headers.

## Operator responsibilities

- Restrict Docker daemon and host access; both can access application secrets
  and database storage.
- Keep ports 80/443 patched and monitored.
- Encrypt backups and test restores.
- Pin and review released container digests before regulated production use.
- Add centralized logs, metrics, alerting, and an off-host backup schedule.
- Do not expose the internal API or PostgreSQL ports through override files.
- Back up the private `lori-secrets` volume together with PostgreSQL. Rotating
  or losing the provider-gateway secret intentionally invalidates existing
  encrypted provider keys and gateway credentials; administrators must re-enter
  upstream keys after recovery.

## Known identity limitations and follow-ups

- There is no outbound email, independent mailbox verification, or password
  recovery. Possession of an administrator-delivered link plus a matching
  account is the v1 membership proof.
- Lori desktop enrollment, deep-link/loopback return handling, and release-build
  OS-keychain credential storage are implemented. A stronger certificate/server
  pinning UX remains a follow-up.
- Organization administrators can search, filter, paginate, and export their
  organization-scoped audit events. CSV export is bounded to 5,000 filtered
  events per request to protect the API from unbounded in-memory responses.
- Independent email verification and recovery, OIDC/SAML SSO, MFA, SCIM, device
  attestation, full synchronizer-token CSRF defenses, and deployment-specific
  HSTS/CSP policy remain follow-ups. Caddy already supplies the current
  conservative browser-security header baseline.
