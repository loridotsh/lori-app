# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Contact the
maintainers privately or use GitHub private vulnerability reporting when it is
enabled for this repository. Include reproduction steps, affected versions,
and an impact assessment.

## Scope

This repository contains the self-hosted Lori Enterprise control plane. Its
security-sensitive surfaces include:

- identity, invitations, optional public sign-up, sessions, roles, and team authorization;
- Lori Desktop enrollment and rotating device credentials;
- organization policy, audit records, and usage analytics;
- company-managed provider credentials and the provider gateway;
- PostgreSQL migrations, backups, and deployment secrets; and
- the Caddy, API, web, and database container boundary.

The Lori Desktop application is maintained in a separate repository.

## Operator responsibility

Production operators must use HTTPS, protect Docker and database access, retain
all documented secret volumes together, encrypt backups, restrict access to
configuration and logs, and apply upgrades only after reviewing migrations and
release instructions. See the [operations guide](docs/OPERATIONS.md#operations).

## Supported versions

Security fixes are provided for the latest published Enterprise release. Older
deployments should upgrade before requesting support unless a maintainer has
explicitly agreed otherwise.
