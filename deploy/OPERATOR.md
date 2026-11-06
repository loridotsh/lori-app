# Deploy Lori Enterprise with Docker

Operators do **not** need the source repository. Lori ships as **container images** plus a **Docker Compose application** published to GHCR (Docker’s recommended pattern for multi-container apps).

For a first installation on a new Mac, use the
[step-by-step setup guide](../docs/SETUP.md). It starts with Docker Desktop
installation and downloading the prebuilt release package. Maintainers building
current source should use the [source-build instructions](../docs/OPERATIONS.md#quick-start-docker-from-source).

**Release scope:** v0.2.0 ships the matched API, dashboard and isolated Work
worker from commit `5c7f2ade988f914157740a44f1ade3371cb862ce`. Linux x86-64 is
qualified; ARM64 / Apple Silicon is not qualified in this release. Keep the
release Compose files and image pins together.

References: [Compose in production](https://docs.docker.com/compose/how-tos/production/), [OCI Compose artifacts](https://docs.docker.com/compose/how-tos/oci-artifact/), [Compose trust model](https://docs.docker.com/compose/trust-model/) (pin versions, use a registry you trust).

## Requirements

- Docker Engine with **Compose 2.34.0+** for the OCI method (Docker Desktop includes Compose)
- For HTTPS: DNS for your hostname; ports **80** and **443** reachable
- Ability to pull from `ghcr.io` (see **Registry access** below)

## Registry access (fixes `401 Unauthorized`)

GHCR packages are **private by default**. Anonymous `docker pull` and `oci://…` only work after the **loridotsh** organization sets these packages to **Public**:

- `lori-enterprise-api`
- `lori-enterprise-web`
- `lori-enterprise-work-worker`
- `lori-enterprise-stack`

The packages remain private. Authenticate with an account authorized for the
packages before installation. The GitHub release assets also require repository
access. No source checkout is needed.

**Org maintainers:** GitHub → **loridotsh** → **Packages** → each package → **Package settings** → **Change visibility** → **Public**.

**Until packages are public**, authenticate once on the server:

```bash
docker login ghcr.io --username YOUR_GITHUB_USERNAME
```

Replace `YOUR_GITHUB_USERNAME` with the authorized account's username. At the
password prompt, enter a personal access token (classic) with `read:packages`;
authorize it for organization SSO if required. See
[GitHub's registry authentication guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-with-a-personal-access-token-classic).
Then run the `docker compose` commands below.

## Method 1 — OCI Compose stack (recommended)

Each release publishes an immutable Compose application to GHCR. You only set your public URL, then use **Docker Compose** (no git clone, no shell installers).

```bash
export LORI_ADDRESS=https://lori.acme.com
export LORI_VERSION=0.2.0

docker compose -f oci://ghcr.io/loridotsh/lori-enterprise-stack:v0.2.0 up -d

docker compose -f oci://ghcr.io/loridotsh/lori-enterprise-stack:v0.2.0 --profile tools run --rm setup-token
```

1. Open `https://lori.acme.com/setup` (use your `LORI_ADDRESS`).
2. Paste the **one-time setup token** printed by the second command.
3. Create the company and first administrator.

Compose may prompt you to confirm loading a remote application; review the summary before accepting.

**Local HTTP trial on Linux x86-64** using the released stack's standard HTTP port:

```bash
export LORI_ADDRESS=http://localhost
export LORI_HTTP_PORT=80
export LORI_HTTPS_PORT=443
docker compose -f oci://ghcr.io/loridotsh/lori-enterprise-stack:v0.2.0 up -d
docker compose -f oci://ghcr.io/loridotsh/lori-enterprise-stack:v0.2.0 --profile tools run --rm --no-deps -T setup-token
```

Open `http://localhost/setup` and paste the printed token line into
**One-time setup token**. For clipboard copying with local Compose files, use
the command in [the setup guide](../docs/SETUP.md).

The OCI stack uses fixed container and host ports 80/443 and a 2 GiB worker
limit. Use the downloadable Compose bundle for custom ports or worker memory
limits; its `compose.yaml` retains those environment-variable overrides.

## Method 2 — Portainer / Docker Desktop (GUI)

1. Download **`lori-enterprise-docker.tar.gz`** from the release link your Lori contact gave you.
2. Unzip on the server (e.g. `/opt/lori-enterprise`).
3. Copy the archive's `env.example` to `.env` and set `LORI_ADDRESS`.
4. In **Portainer**: *Stacks* → *Add stack* → paste or upload `compose.yaml`, add override `compose.images.yaml`, set env vars from `.env`.
5. Deploy, then run the **setup-token** one-shot container from the stack UI (profile `tools`).

Same files work in **Docker Desktop** by opening the folder and running Compose with `compose.yaml` + `compose.images.yaml`. The image override already contains the release's immutable digests; do not add `compose.release.yaml`, which requires separately supplied image environment variables before overrides are merged.

## Method 3 — Compose files only (air-gapped)

Use the release archive (compose + digest-pinned `compose.images.yaml` + `env.example`). No OCI URL is required. An offline host must also have the matching images loaded or available from its internal registry:

```bash
cd /opt/lori-enterprise
cp env.example .env   # edit LORI_ADDRESS
docker compose -f compose.yaml -f compose.images.yaml up -d
docker compose -f compose.yaml -f compose.images.yaml --profile tools run --rm setup-token
```

## Upgrade

Set `LORI_ADDRESS` as before, then:

```bash
docker compose -f oci://ghcr.io/loridotsh/lori-enterprise-stack:v0.2.0 up -d
```

Replace `v0.2.0` with the exact published version you intend to install. Back up
database and secret volumes before upgrading (see main README).

## What Docker cannot automate

For security, the **first administrator** must complete `/setup` in a browser with a **one-time token** from the `setup-token` service. That step is intentional (prevents anyone on the internet from claiming your deployment).
## Cloud Work in current source

These features are included in the coordinated v0.2.0 API, web and worker release.

Cloud Work adds cowork conversations, files, approved tools, bundled skills,
private memory, and connected plugins to the same stack. Use **Manage / Work**
to switch between enterprise controls and the cowork workspace. The administrator
enables Work in **Manage → Work access** and assigns company providers and
models; Cloud Work then follows that same policy automatically. Disabling Work
there also stops Cloud runs already in progress.

Digest-pinned installs must include the matched `LORI_ENTERPRISE_WORKER_IMAGE`
alongside the API and web images. Back up `lori-work-cloud-secrets` and
`lori-work-cloud-files` with PostgreSQL and the other secret volumes. The worker
mounts only the dedicated worker secret; the API owns the file volume.

See [Cloud Work architecture and qualification](../docs/WORK_CLOUD.md) for
implemented capabilities, limits, recovery, and release gates. Commands and
document generation require the hardened Linux worker runtime probe to pass;
keep Docker's default security protections enabled. Current file storage requires
a consistent private filesystem; scaling workers does not establish multi-node HA.
