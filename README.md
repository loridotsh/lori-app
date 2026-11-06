<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lori-hero-dark.svg">
  <img src="docs/assets/lori-hero-light.svg" alt="A member asks Lori for a launch deck, approves the command, and receives the finished file." width="100%">
</picture>

# Lori

A private AI workspace for people and teams. Ask for the work, approve what
runs, and get finished files back, on models and infrastructure you control.

## What you get

| | |
| --- | --- |
| **Work** | Chat that plans, uses tools, and asks before it acts. |
| **Documents** | PDF, Word, Excel and PowerPoint, built in an isolated sandbox and previewed in place. |
| **Models** | Bring your own providers. Chat, image and video models live in one picker. |
| **Knowledge** | Projects, memory, skills and plugins that carry context between chats. |
| **Teams** | Personal and organization workspaces, with roles, invitations, policy and audit. |
| **Your server** | One Docker Compose stack. Keys stay encrypted on your host. |

## Run it

You need [Docker](https://docs.docker.com/get-docker/).

```bash
git clone https://github.com/loridotsh/lori-app.git
cd lori-app
export LORI_ADDRESS=http://localhost:8180 LORI_HTTP_PORT=8180 LORI_HTTPS_PORT=8443
docker compose build
docker compose up -d --no-build --wait
docker compose run --rm setup-token
```

Open [localhost:8180/setup](http://localhost:8180/setup), paste the token, and
create the first administrator.

## Develop

You need Node.js 22 and PostgreSQL 17.

```bash
npm install
npm run dev
```

The dashboard runs on `localhost:3000` and the API on `localhost:4000`. To run
Work with its sandbox, start Docker and use
`npm run dev:cloud:build-worker`, then `npm run dev:cloud`.

Before opening a pull request:

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## Learn more

- [Operations](docs/OPERATIONS.md): deployment, backups, upgrades and recovery
- [Architecture](docs/ARCHITECTURE.md): how the pieces fit together
- [Cloud Work](docs/WORK_CLOUD.md): files, approvals, sandboxing and limits
- [Image and video](docs/WORK_MEDIA.md): generating media from the model picker
- [Product guide](docs/handbook/README.md): everything the app can do
- [Security](SECURITY.md): how to report a vulnerability

## Contributors

Piyush

## License

[MIT](LICENSE)
