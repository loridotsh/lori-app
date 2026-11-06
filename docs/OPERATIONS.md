# Operations

The full reference for deploying, developing and running Lori: identity, policy,
device enrollment, company-managed AI providers and operations tooling in one
deployable stack.

Lori Desktop is developed in a separate repository. This project ships the API,
dashboard, database migrations and Docker deployment, not the desktop app or its
release pipeline.

## Contents

- [Capabilities](#capabilities)
- [Quick start (Docker)](#quick-start-docker)
- [Local development](#local-development)
- [Validate changes](#validate-changes)
- [Documentation](#documentation)
- [Repository layout](#repository-layout)
- [Operations](#operations)
- [License](#license)

## Capabilities

- **Dashboard** — Next.js (App Router), Tailwind CSS v4, shadcn-compatible UI,
  light/dark/system themes.
- **API** — TypeScript Fastify service with `/health/live` and `/health/ready`.
- **Data** — PostgreSQL 17, forward-only checksum-verified migrations with an
  advisory lock.
- **Identity** — Email/password auth (Better Auth), invite-only by default with
  optional public sign-up, first-admin bootstrap, admin/member roles, invitation
  links, session revocation, audit events.
- **Desktop enrollment** — Browser approval, PKCE-bound codes, rotating device
  tokens, immediate revocation, canonical-origin `lori://` launch links (no
  credentials in the URL).
- **Policy** — Organization, team, and member layers for apps, MCP plugins,
  skills, and providers; team admins with scoped delegation; audited changes.
- **Delivery** — PostgreSQL-backed long polling to desktops, with ETag polling
  as a fallback during upgrades or outages.
- **Provider gateway** — Encrypted upstream keys on the server; short-lived
  device-scoped credentials; model allowlists and per-device limits enforced on
  every request.
- **Usage analytics** — Organization-level usage views with admin-configurable
  visibility and retention settings (not centralized provider billing budgets).
- **Production posture** — Caddy as the only public service, auto HTTPS,
  generated DB password in a private volume, non-root read-only containers.

**Not in scope today:** SSO (OIDC/SAML), outbound email, self-service password
recovery, arbitrary upstream provider URLs, full provider API surface area, or
advanced long-term audit retention policies. The provider gateway intentionally
exposes only the fixed endpoint set required by Lori’s bundled provider catalog.

## How policy reaches coding tools

1. Administrators assign catalog items at the organization or team level. Team
   grants add together; an explicit member override wins last.
2. Enrolled Lori desktops pull merged effective policy and reconcile Lori’s
   marketplace and provider configuration into supported coding tools.
3. Removing access takes effect on the next desktop refresh. The provider gateway
   re-checks device, membership, and policy on every call, so revoked devices
   cannot keep using old credentials.

Organization policy does not delete a member’s local files. When personal access
is allowed, saved personal configuration can become effective again after an
organization grant is removed; when personal access is restricted, it stays on
disk but is removed from effective tool configuration.

## Deploy for operators (Docker only)

Enterprises do **not** need this source repository. Use **Docker Compose** with the
published container images. For a first installation, start with
[Install Lori Enterprise on a new Mac](SETUP.md): it covers installing
Docker Desktop, downloading the release package, registry access, startup and
first-admin setup. Advanced deployment options are in
[deploy/OPERATOR.md](../deploy/OPERATOR.md).

The latest release is v0.2.0 for Linux x86-64; ARM64 / Apple Silicon is not
qualified. Registry packages remain private and require an authorized Docker login.
If Docker and registry access are already configured, the OCI method is:

```bash
export LORI_ADDRESS=https://lori.acme.com
docker compose -f oci://ghcr.io/loridotsh/lori-enterprise-stack:v0.2.0 up -d
docker compose -f oci://ghcr.io/loridotsh/lori-enterprise-stack:v0.2.0 --profile tools run --rm setup-token
```

Open `/setup`, paste the token, and create the first administrator. Portainer and
offline bundles are documented in [deploy/OPERATOR.md](../deploy/OPERATOR.md).
Prebuilt packages are shared with customers privately. Everyone else can build
from source as described below.

## Quick start (Docker, from source)

This section is for maintainers building current source. Customer installation
uses the prebuilt package in the [setup guide](SETUP.md). The published v0.2.0 package includes the matched API, dashboard and Work
worker for Linux x86-64. ARM64 / Apple Silicon is not qualified for this release.

Install Git and Docker first, obtain repository access, then get the source:

```bash
git clone https://github.com/loridotsh/lori-app.git
cd lori-app
```

Evaluate locally with HTTP on port 8180:

```bash
cp .env.example .env   # optional; defaults work for local HTTP
export LORI_ADDRESS=http://localhost:8180
export LORI_HTTP_PORT=8180
export LORI_HTTPS_PORT=8443
docker compose build
docker compose up -d --no-build --wait
```

Open [http://localhost:8180](http://localhost:8180). Enterprise does not depend
on a hosted Lori Dashboard.

**First administrator**

Open `/setup` in the browser. The setup page explains how to retrieve the
one-time operator token on the Docker host (with copy-ready commands). In short,
on the server:

```bash
docker compose run --rm setup-token
```

Paste the printed line into the setup form and create the organization owner.
The token expires after 30 minutes and cannot be reused after setup completes.
If it expires first:

```bash
docker compose --profile tools run --rm setup-token-rotate
docker compose restart api
```

**Production hostname** (DNS must point at the host; ports 80/443 reachable for
ACME):

```bash
LORI_ADDRESS=lori.acme.com docker compose up -d --build
curl --fail https://lori.acme.com/api/health/ready
```

On first launch, the `bootstrap` service creates database and application
secrets, the setup token, and provider-gateway encryption material. Runtime
services mount only the volumes they need: `lori-database-secrets`,
`lori-app-secrets`, and `lori-setup-secrets`. A legacy `lori-secrets` volume
may remain for rollback compatibility—back up all secret volumes together.
Losing the provider-gateway secret makes existing company-provider connections
unreadable.

Release images and deployment bundles are built and published manually.
Record digest-pinned `ghcr.io/<org>/lori-enterprise-api` and
`lori-enterprise-web` references for `compose.release.yaml` in each release.
Pushing a version tag does not publish a release. See [Upgrade](#upgrade).

## Local development

**Requirements:** Node.js 22 and PostgreSQL 17 (`brew install postgresql@17` on
macOS).

```bash
npm install
npm run dev
```

This command ensures a project-local PostgreSQL cluster under `.local/postgres`
(on `127.0.0.1:55432`), runs migrations, and starts the API and web app:

| Service | URL |
| --- | --- |
| Dashboard | http://localhost:3000 |
| API | http://localhost:4000 |

Stop only the dev database when finished:

```bash
npm run dev:db:stop
```

Copy `.env.example` when tuning Compose-based deployments. Local `npm run dev`
uses the script in `scripts/dev-postgres.mjs` and does not require Docker.

To run Cloud Work with document generation on macOS or Windows, start your
existing Docker engine (Docker Desktop or Colima), build the worker image, then
start the local workflow:

```bash
npm run dev:cloud:build-worker
npm run dev:cloud
```

It starts the API, dashboard, and actual Rust worker with a shared private
credential at `.local/cloud-worker-secret` and files at `.local/cloud-files`.
Root `.env` settings are loaded once for all services, with exported process
variables taking precedence. `PORT` selects the API/worker connection port;
`LORI_ADDRESS` selects the dashboard's loopback HTTP hostname and port. Explicit
worker credentials and file directories are respected. For example, use
`LORI_ADDRESS=http://127.0.0.1:3118 npm run dev:cloud` for a custom dashboard port.
It does not change an organization's providers or policy. Cloud Work follows
Work access: an administrator enables Work and assigns a company provider and
permitted model in Manage → Work access. Plain `npm run dev` runs no worker, so
Cloud execution is unavailable. On macOS and Windows, `dev:cloud` runs the
hardened Linux worker image with no host directory or Docker socket mounts.
PDF/Office generation, conversion, rendering, and commands are offered only
after its isolation and document-library probes pass. Missing Docker/image or
failed qualification stops startup rather than silently serving text-only runs.
The file panel previews PDF, DOCX/XLSX/PPTX, DOC/XLS/PPT, and ODT/ODS/ODP
as private page images with pagination and zoom. Preview rendering uses the
same qualified worker, without a model call or new conversation files. Images,
Markdown, CSV/TSV, and text/code retain their native preview modes. Formats the
runtime cannot render remain downloadable with a clear fallback message.
Cloud members can choose **Ask Me** or **Approve for Me** from the composer or
Work Settings. Ask Me is the default. The setting belongs to that member in
that organization; organization-enforced Ask Me always takes precedence.
Automatic approvals retain the same action, sandbox, and file-conflict checks
and are recorded separately from manual approvals.
Rebuild the image after worker/runtime changes. On Linux, the default is a
native worker (Rust 1.92+) with a configured, qualified runtime; Docker mode can
be selected with `WORK_CLOUD_DEV_WORKER=docker` and an API reachable from its
bridge. `WORK_CLOUD_DEV_API_HOST` overrides the container's host API hostname;
`WORK_CLOUD_DEV_WORKER_IMAGE` selects an already-built image. For deliberately
limited chat/text-file development, use `WORK_CLOUD_DEV_WORKER=text` (Rust
required). This mode does not provide PDF/Office generation.
Stop the foreground command to stop
all three services; the development database remains available until
`npm run dev:db:stop`.

Desktop enrollment during development is documented in
[docs/DESKTOP_ENROLLMENT.md](DESKTOP_ENROLLMENT.md) (including the debug
loopback handoff when `lori://` is not registered).

## Validate changes

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Run these checks locally before review and release; this repository has no
GitHub Actions workflows. Integration tests honor `LORI_TEAM_INTEGRATION_TEST` and
`LORI_USAGE_INTEGRATION_TEST` when a database is available.

## Documentation

- [Lori product guide: application and Enterprise functionality](handbook/README.md)
- [Cloud Work generative responses](WORK_CLOUD_GEN_UI.md)
- [Image and video generation](WORK_MEDIA.md)

| Document | Purpose |
| --- | --- |
| [docs/SETUP.md](SETUP.md) | First installation on a new Mac: Docker, release download, prebuilt images, and company/admin setup |
| [docs/ARCHITECTURE.md](ARCHITECTURE.md) | Deployment model, identity, policy, gateway, and capability boundaries |
| [docs/DESKTOP_ENROLLMENT.md](DESKTOP_ENROLLMENT.md) | Lori desktop enrollment protocol v1 |
| [docs/SECURITY.md](SECURITY.md) | Implemented security controls and operator notes |
| [SECURITY.md](../SECURITY.md) | Vulnerability reporting and supported versions |
| [PRODUCT.md](../PRODUCT.md) | Product principles and design constraints for UI work |

## Repository layout

```text
apps/
  api/          Control-plane API, auth, policy, migrations
  web/          Next.js admin dashboard
packages/
  contracts/    Shared TypeScript contracts for API and web
docs/           Architecture, enrollment, and security references
scripts/        Local PostgreSQL helper for development
compose.yaml    Image-based deployment stack
compose.override.yaml   Source builds (auto-loaded in this repo)
compose.release.yaml    Digest-pinned release overrides
Caddyfile       Edge routing reference for local TLS experiments
```

## Operations

### Logs and database

```bash
docker compose ps
docker compose logs --tail=200 api web database edge
docker compose exec database psql -U lori -d lori_enterprise
```

Only the `edge` service publishes host ports.

### Identity and recovery

- Registration is invitation-only after setup, unless `LORI_PUBLIC_SIGNUP` is on.
- Invitation links are administrator-generated and delivered out of band.
- Password recovery is operator-driven (no self-service reset email flow).

Reset a locked-out administrator (password via stdin, not shell history):

```bash
read -rsp "New Enterprise password: " LORI_ADMIN_RESET_PASSWORD && echo
printf '%s' "$LORI_ADMIN_RESET_PASSWORD" | docker compose --profile tools run --rm -T admin-reset \
  --email admin@acme.com \
  --confirm-email admin@acme.com \
  --new-password-stdin
unset LORI_ADMIN_RESET_PASSWORD
```

Each organization has exactly one Owner. Only the Owner appoints, changes, or
removes administrators and transfers ownership (People → Transfer ownership,
which requires a sign-in within the last 15 minutes). Upgrades promote the
original setup administrator to Owner when that account is still an
administrator. If it is not, assign an existing administrator as Owner
(audited, and refused when an Owner already exists):

```bash
docker compose --profile tools run --rm -T owner-assign \
  --email admin@acme.com \
  --confirm-email admin@acme.com
```

### Hosted Dashboard separation

Self-hosted Enterprise does not register with, pair to, or report status to the
hosted Lori Dashboard. Upgrades from Dashboard-linked builds apply migration
`014_remove_dashboard_registration.sql` and remove legacy instance identity
artifacts. After a healthy upgrade, operators may delete an unused
`lori-enterprise_lori-identity-secrets` volume if it remains.

### Lori desktop enrollment (operator summary)

Browser flows live at `/connect` and `/api/v1/enrollment/*`. Signed-in users can
use **Open Lori**, which launches
`lori://connect?server={canonical-origin}&protocol=1` without embedding
session or token material. Full state machine and API contracts:
[docs/DESKTOP_ENROLLMENT.md](DESKTOP_ENROLLMENT.md).

### Backup

```bash
docker compose exec -T database \
  pg_dump -U lori -d lori_enterprise -Fc > lori-enterprise.dump
```

```bash
docker compose exec -T database \
  pg_restore -U lori -d lori_enterprise --clean --if-exists < lori-enterprise.dump
```

Encrypt backups at rest and restrict access.

### Upgrade

Back up first, then:

```bash
docker compose up -d --build
```

Release deployments (use the digest pins from the GitHub Release for your
version):

```bash
LORI_ENTERPRISE_API_IMAGE='ghcr.io/<org>/lori-enterprise-api@sha256:…' \
LORI_ENTERPRISE_WEB_IMAGE='ghcr.io/<org>/lori-enterprise-web@sha256:…' \
LORI_ENTERPRISE_WORKER_IMAGE='ghcr.io/<org>/lori-enterprise-work-worker@sha256:…' \
LORI_VERSION='1.2.3' \
docker compose -f compose.yaml -f compose.release.yaml up -d
```

Migrations are forward-only. The API refuses to start if a migration fails or a
previously applied file was edited.

Enterprise Cloud cowork uses the **Manage / Work** switch and the same enrolled
Lori desktop. See [Cloud Work architecture](WORK_CLOUD.md) for files,
approvals, document execution, plugins, skills, memory, limits, and qualification.
Back up the cloud file and worker secret volumes together with PostgreSQL.

### Uninstall

`docker compose down` keeps data volumes. `docker compose down --volumes`
destroys all Enterprise data and secrets.

## License

[MIT](../LICENSE)
