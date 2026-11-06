# Install Lori Enterprise on a new Mac

Start here if Lori Enterprise and Docker are not installed on your computer.
You will install Docker, download the Enterprise package, start its prebuilt
containers, and create your company and first administrator.

The customer installation uses released images. You do not need to clone the
repository, install development tools, or compile the application. The small
download contains deployment configuration; Docker downloads the application
images when you install it.

For a shared company server with a domain and HTTPS, see the
[operator guide](../deploy/OPERATOR.md). This walkthrough installs on your Mac
at **http://localhost**.

## Before you start: get access to the package

Prebuilt packages are shared with customers privately, so this guide needs the
release link and registry access from your Lori contact. An image pull returning
401/403 can mean access is missing. To try Lori without a package, build it from
source as the [README](../README.md#run-it) describes.

Prebuilt packages can lag the source, so check with your contact which Work
features yours includes.

Have your company name, administrator name and email, and a password of 12–128
characters ready.

## 1. Install Docker Desktop

1. Open [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/).
2. Click the download for your Mac: **Apple silicon** or **Intel**. You can check
   the chip under **Apple menu → About This Mac**.
3. Open the downloaded `Docker.dmg` and drag **Docker** to **Applications**.
4. Open **Applications → Docker** and complete its first-run setup.
5. Wait until Docker Desktop reports that its engine is running.

Open **Terminal** from Applications → Utilities, then check:

```bash
docker --version
docker compose version
docker info
```

The first two commands should show version numbers; the third should connect
to the engine. If `docker` is not found, complete Docker Desktop's command-line
tool setup and reopen Terminal. If it cannot connect, start Docker Desktop and
wait for the engine. Docker Desktop includes Docker Compose.

## 2. Download the Enterprise installation package

1. Sign in to GitHub with the account granted access by your administrator.
2. Open the release link your Lori contact gave you.
3. Under **Assets**, download **`lori-enterprise-docker.tar.gz`** to Downloads.
   Choose that file, rather than GitHub's automatic source-code archives.

Create a new installation folder and extract the package:

```bash
mkdir "$HOME/lori-enterprise" &&
tar -xzf "$HOME/Downloads/lori-enterprise-docker.tar.gz" -C "$HOME/lori-enterprise" &&
cd "$HOME/lori-enterprise"
```

If the folder already exists, stop and choose a new empty installation folder,
or use the existing installation's configuration. Do not extract over it.
If your browser already extracted the archive, move the extracted files into
the new folder and open Terminal there instead.

Check that these files are present:

```bash
ls compose.yaml compose.images.yaml env.example
```

`compose.images.yaml` contains the release's exact API and web image references.
Keep it with the package's `compose.yaml`.

## 3. Sign in to the image registry

This is needed while the Enterprise images are private. The authorized GitHub
account needs a **personal access token (classic)** with **`read:packages`**.
Your administrator must also grant that account access to the packages. Follow
[GitHub's Container registry authentication instructions](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-with-a-personal-access-token-classic)
to create the token; authorize it for organization SSO if required.

Replace `YOUR_GITHUB_USERNAME` with your GitHub username and run:

```bash
docker login ghcr.io --username YOUR_GITHUB_USERNAME
```

At the password prompt, paste the access token. Wait for **Login Succeeded**.
The registry credential downloads the software; the one-time administrator
setup token in step 6 is generated separately by your new installation.

## 4. Configure the installation

In the installation folder from step 2, copy the supplied settings template:

```bash
cp env.example .env
open -e .env
```

Replace the file's contents with these settings and save:

```dotenv
COMPOSE_FILE=compose.yaml:compose.images.yaml
COMPOSE_PROJECT_NAME=lori-enterprise
LORI_ADDRESS=http://localhost
LORI_HTTP_PORT=80
LORI_HTTPS_PORT=443
LORI_VERSION=0.1.2
```

`COMPOSE_FILE` makes the commands below load both release files automatically,
including the prebuilt image references. The colon separator is for Mac/Linux.
Docker Compose reads `.env` from the installation folder, so run subsequent
commands from that same folder.

Database passwords and application secrets are generated automatically at first
startup. You do not need to enter them in this file.

Check the configuration:

```bash
docker compose config --quiet
```

It should finish without an error. This does not start the installation.

## 5. Download and start the prebuilt application

Download the images and start Enterprise:

```bash
docker compose pull
docker compose up -d --wait --wait-timeout 180
```

The first download can take several minutes. Docker starts the database,
applies migrations, generates secrets, and starts the API and dashboard. There
is no application build step on the customer's machine.

Check the installation:

```bash
docker compose ps
curl --fail http://localhost/api/health/ready
```

The API, dashboard and database should be healthy. The readiness response
should contain `"status":"ok"`.

## 6. Copy the one-time administrator setup token

Run this in the same installation folder:

```bash
docker compose --profile tools run --rm --no-deps -T setup-token | pbcopy
```

It copies the token directly to your Mac clipboard. It normally prints no token
because its output goes to the clipboard. If Terminal shows an error, resolve
it before pasting.

Open the setup page:

```bash
open http://localhost/setup
```

Click **One-time setup token** and press **Cmd+V**. For manual copying, run:

```bash
docker compose --profile tools run --rm --no-deps -T setup-token
```

Copy the complete printed token line into the form. The token proves you
control the installation before creating its first administrator. It expires
30 minutes after its creation.

## 7. Create your company and first administrator

| Field | What to enter |
| --- | --- |
| One-time setup token | Paste the token from step 6 |
| Company name | Your company name |
| Your name | Your administrator display name |
| Admin email | The email you will use to sign in |
| Password | Your password, 12–128 characters |
| Confirm password | The same password |

Click **Create organization**. Wait for **Organization setup complete**, check
your email and **admin** role, then click **Open control dashboard**.

Your Enterprise installation is now configured. Save the administrator
credentials in your password manager; this release has no password-recovery
email. Future visits use **http://localhost/sign-in**.

## 8. Configure company access and invite members

- Open **Organization → Providers** to connect company-owned AI credentials and
  assign provider access through organization or team policies.
- Open **People → Invite member** to create an invitation link. Share it with
  the intended member; invitation emails are not sent automatically.
- To connect a desktop, first obtain and install your company's approved
  Lori Desktop build, open it, then
  use **Connect Lori desktop** on the Enterprise welcome page and complete
  browser approval. The Enterprise Docker package installs the server; the
  desktop application is installed separately.

A localhost installation is reachable from this Mac. For other employees to
connect from their computers, deploy to a company server with a shared address
and HTTPS using the [operator guide](../deploy/OPERATOR.md).

## Recovery

### The token expired

Generate a replacement, copy it, and restart the API:

```bash
docker compose --profile tools run --rm --no-deps -T setup-token-rotate | pbcopy
docker compose restart api
docker compose ps
```

Wait for the API to be healthy, reload `/setup`, and paste the new token. Printing
the old token again does not extend its expiry time.

### Download says 404, or image download says 401/403

Confirm you are using the authorized GitHub account and that your administrator
granted access to both the release and the container packages. Repeat step 3
with a valid registry credential. If you have not been granted access, the
administrator must resolve that before installation can continue.

### Docker is missing or stopped

Complete step 1, open Docker Desktop, and wait for its engine. On a new Mac,
`colima start` is not an installation step; Colima only works after it has been
installed and configured separately.

### The application does not start

From the installation folder, inspect:

```bash
docker compose ps --all
docker compose logs --tail=100 api web database edge
```

Check that ports 80 and 443 are available and `.env` contains the settings from
step 4. This release's port mappings differ from current source; use the
matching files from its package. Share the relevant error text when seeking
help.

### Stop or resume the installation

```bash
docker compose stop
docker compose up -d --wait --wait-timeout 180
```

The company, database and secrets remain in Docker volumes. Resuming uses the
same organization; it does not repeat first-time setup.

## What has been checked

The package contents, digest-pinned image configuration, standard ports, token
services and setup-form labels were checked against the actual v0.1.2 release.
Docker installation and registry authentication follow the official vendor
instructions linked above. This review did not perform a fresh-machine Docker
installation or an authenticated end-to-end pull/start of the released images.
