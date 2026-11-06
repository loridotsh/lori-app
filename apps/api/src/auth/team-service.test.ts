import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { AppConfig } from "../config.js";
import type { LoriAuth } from "./auth.js";
import { EnrollmentService } from "./enrollment-service.js";
import { IdentityService } from "./identity-service.js";
import { TeamService } from "./team-service.js";
import { generateDesktopToken, hashDesktopToken } from "./desktop-tokens.js";
import { PostgresPolicyUpdates } from "./policy-updates.js";

const integrationDescribe =
  process.env.LORI_TEAM_INTEGRATION_TEST === "1" ? describe : describe.skip;

const config: AppConfig = {
  auth: {
    secret: "test-auth-secret-that-is-at-least-32-characters",
    secureCookies: false,
    setupToken: "test-setup-token-that-is-at-least-32-characters",
  },
  database: {
    host: process.env.DATABASE_HOST ?? "127.0.0.1",
    name: process.env.DATABASE_NAME ?? "lori_enterprise",
    password:
      process.env.DATABASE_PASSWORD ??
      "development-database-password-change-me",
    port: Number(process.env.DATABASE_PORT ?? 55432),
    ssl: false,
    user: process.env.DATABASE_USER ?? "lori",
  },
  environment: "test",
  gateway: {
    secret: "test-provider-gateway-secret-at-least-32-characters",
  },
  host: "127.0.0.1",
  logLevel: "silent",
  port: 4000,
  publicUrl: "https://lori.acme.com",
  trustProxy: false,
  version: "test",
};

integrationDescribe("TeamService PostgreSQL integration", () => {
  const schema = `team_test_${randomUUID().replaceAll("-", "")}`;
  const organizationId = "organization-1";
  const adminUserId = "user-admin";
  const adminMemberId = "member-admin";
  const memberUserId = "user-member";
  const memberId = "member-1";
  const secondUserId = "user-second";
  const secondMemberId = "member-2";
  let sessionUserId = adminUserId;
  let adminPool: Pool;
  let pool: Pool;
  let schemaCreated = false;
  let enrollment: EnrollmentService;
  let identity: IdentityService;
  let policyUpdates: PostgresPolicyUpdates;
  let service: TeamService;

  beforeAll(async () => {
    const poolConfig = {
      database: config.database.name,
      host: config.database.host,
      password: config.database.password,
      port: config.database.port,
      ssl: config.database.ssl,
      user: config.database.user,
    };
    adminPool = new Pool(poolConfig);
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    pool = new Pool({
      ...poolConfig,
      options: `-c search_path=${schema},public`,
    });
    const migrationDirectory = resolve(import.meta.dirname, "../../migrations");
    for (const file of readdirSync(migrationDirectory)
      .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
      .sort()) {
      await pool.query(readFileSync(resolve(migrationDirectory, file), "utf8"));
    }
    await pool.query(
      `
        INSERT INTO "user" (
          id, name, email, "emailVerified", "createdAt", "updatedAt"
        )
        VALUES
          ($1, 'Admin User', 'admin@example.com', TRUE, NOW(), NOW()),
          ($2, 'Member User', 'member@example.com', TRUE, NOW(), NOW()),
          ($3, 'Second User', 'second@example.com', TRUE, NOW(), NOW())
      `,
      [adminUserId, memberUserId, secondUserId],
    );
    await pool.query(
      `
        INSERT INTO organization (id, name, slug, "createdAt")
        VALUES ($1, 'Acme', 'acme', NOW())
      `,
      [organizationId],
    );
    await pool.query(
      `
        INSERT INTO member (
          id, "organizationId", "userId", role, "createdAt"
        )
        VALUES
          ($1, $4, $5, 'admin', NOW()),
          ($2, $4, $6, 'member', NOW()),
          ($3, $4, $7, 'member', NOW())
      `,
      [
        adminMemberId,
        memberId,
        secondMemberId,
        organizationId,
        adminUserId,
        memberUserId,
        secondUserId,
      ],
    );
    await pool.query(
      `
        INSERT INTO organization_policies (organization_id)
        VALUES ($1)
      `,
      [organizationId],
    );
    const auth = {
      api: {
        getSession: async () => ({
          session: { id: "session-1", userId: sessionUserId },
          user: { id: sessionUserId },
        }),
      },
    } as unknown as LoriAuth;
    enrollment = new EnrollmentService(pool, auth, config);
    service = new TeamService(pool, auth, config, enrollment);
    identity = new IdentityService(pool, auth, config);
    policyUpdates = new PostgresPolicyUpdates(pool);
    await policyUpdates.start();
  }, 30_000);

  beforeEach(async () => {
    sessionUserId = adminUserId;
    await pool.query(
      `
        UPDATE member
        SET role = CASE WHEN id = $1 THEN 'admin' ELSE 'member' END
        WHERE "organizationId" = $2
      `,
      [adminMemberId, organizationId],
    );
    await pool.query("DELETE FROM device_refresh_tokens");
    await pool.query("DELETE FROM device_sessions");
    await pool.query("DELETE FROM devices");
    await pool.query("DELETE FROM team");
    await pool.query("DELETE FROM member_policy_overrides");
    await pool.query("DELETE FROM member_catalog_overrides");
    await pool.query("DELETE FROM organization_catalog_policies");
    await pool.query(
      "DELETE FROM audit_events WHERE subject_type = 'team'",
    );
    await pool.query(
      `
        UPDATE organization_policies
        SET
          revision = 1,
          allow_personal_plugins = FALSE,
          allow_personal_providers = FALSE,
          allow_personal_skills = FALSE,
          updated_at = NOW(),
          updated_by_user_id = NULL
        WHERE organization_id = $1
      `,
      [organizationId],
    );
  });

  afterAll(async () => {
    await policyUpdates?.close();
    await pool?.end();
    if (adminPool && schemaCreated) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    if (adminPool) {
      await adminPool.end();
    }
  });

  it("creates, lists, updates, and deletes teams with revision and audit changes", async () => {
    const created = await service.createTeam(
      {},
      {
        description: "Shared platform ownership",
        name: "Platform",
        slug: "platform",
      },
    );
    expect(created).toMatchObject({
      description: "Shared platform ownership",
      memberCount: 0,
      name: "Platform",
      slug: "platform",
    });
    expect((await service.listTeams({})).teams).toHaveLength(1);

    const updated = await service.updateTeam({}, created.id, {
      description: "Developer platform",
      name: "Platform Engineering",
    });
    expect(updated).toMatchObject({
      description: "Developer platform",
      name: "Platform Engineering",
      slug: "platform",
    });

    await expect(
      service.createTeam({}, { name: "Duplicate", slug: "platform" }),
    ).rejects.toMatchObject({ code: "team_slug_exists", statusCode: 409 });

    await service.deleteTeam({}, created.id);
    expect((await service.listTeams({})).teams).toEqual([]);
    const revision = await pool.query<{ revision: string }>(
      `
        SELECT revision::text
        FROM organization_policies
        WHERE organization_id = $1
      `,
      [organizationId],
    );
    expect(Number(revision.rows[0]?.revision)).toBe(4);
    const audit = await pool.query<{ action: string }>(
      `
        SELECT action
        FROM audit_events
        WHERE subject_type = 'team'
        ORDER BY created_at
      `,
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      "team.created",
      "team.updated",
      "team.deleted",
    ]);
  });

  it("publishes committed policy and device-revocation changes", async () => {
    const policyScope = {
      deviceId: randomUUID(),
      organizationId,
    };
    let sequence = policyUpdates.snapshot();
    const created = await service.createTeam(
      {},
      { name: "Live Updates", slug: "live-updates" },
    );
    let policyUpdate = null;
    for (let attempt = 0; attempt < 3 && policyUpdate?.revision !== 2; attempt += 1) {
      policyUpdate = await policyUpdates.waitForChange(
        policyScope,
        sequence,
        1_000,
      );
      sequence = policyUpdate?.sequence ?? policyUpdates.snapshot();
    }
    expect(policyUpdate).toMatchObject({ kind: "policy", revision: 2 });

    const deviceId = randomUUID();
    await pool.query(
      `
        INSERT INTO devices (
          id, organization_id, user_id, name, platform, app_version
        )
        VALUES ($1, $2, $3, 'Revoked Mac', 'macos', '1.5.4')
      `,
      [deviceId, organizationId, memberUserId],
    );
    const sessionId = randomUUID();
    await pool.query(
      `
        INSERT INTO device_sessions (
          id, device_id, token_family_id, access_token_hash, access_expires_at
        )
        VALUES ($1, $2, $3, $4, NOW() + INTERVAL '15 minutes')
      `,
      [
        sessionId,
        deviceId,
        randomUUID(),
        hashDesktopToken(
          generateDesktopToken("access"),
          config.auth.secret,
          "access",
        ),
      ],
    );
    sequence = policyUpdates.snapshot();
    await pool.query(
      "UPDATE device_sessions SET revoked_at = NOW(), revoked_reason = 'test' WHERE id = $1",
      [sessionId],
    );
    const sessionRevocation = await policyUpdates.waitForChange(
      { deviceId, organizationId },
      sequence,
      1_000,
    );
    expect(sessionRevocation).toMatchObject({
      deviceId,
      kind: "access_revoked",
      organizationId,
    });

    sequence = policyUpdates.snapshot();
    await enrollment.revokeDevice({}, deviceId, true);
    const revocation = await policyUpdates.waitForChange(
      { deviceId, organizationId },
      sequence,
      1_000,
    );
    expect(revocation).toMatchObject({
      deviceId,
      kind: "access_revoked",
      organizationId,
    });
    await service.deleteTeam({}, created.id);
  });

  it("replaces a device inventory report and exposes provenance to administrators", async () => {
    const deviceId = randomUUID();
    const accessToken = generateDesktopToken("access");
    await pool.query(
      `
        INSERT INTO devices (
          id, organization_id, user_id, name, platform, app_version
        )
        VALUES ($1, $2, $3, 'Member Mac', 'macos', '1.5.4')
      `,
      [deviceId, organizationId, memberUserId],
    );
    await pool.query(
      `
        INSERT INTO device_sessions (
          id, device_id, token_family_id, access_token_hash, access_expires_at
        )
        VALUES ($1, $2, $3, $4, NOW() + INTERVAL '15 minutes')
      `,
      [
        randomUUID(),
        deviceId,
        randomUUID(),
        hashDesktopToken(accessToken, config.auth.secret, "access"),
      ],
    );

    await enrollment.reportDesktopInventory(`Bearer ${accessToken}`, {
      items: [
        {
          enabled: true,
          enabledAgents: ["codex", "claude"],
          id: "frontend-design",
          name: "Frontend Design",
          organizationManaged: false,
          type: "skill",
        },
      ],
      policyRevision: 9,
      syncError: null,
      syncStatus: "synced",
    });

    await expect(enrollment.listOrganizationDevices({})).resolves.toMatchObject({
      devices: [
        {
          id: deviceId,
          inventory: {
            items: [
              {
                enabledAgents: ["claude", "codex"],
                id: "frontend-design",
                organizationManaged: false,
              },
            ],
            policyRevision: 9,
            syncError: null,
            syncStatus: "synced",
          },
        },
      ],
    });
  });

  it("supports multiple memberships and confines team admins to their team", async () => {
    const teamA = await service.createTeam({}, { name: "Team A", slug: "team-a" });
    const teamB = await service.createTeam({}, { name: "Team B", slug: "team-b" });
    await service.addTeamMember({}, teamA.id, memberId, "team_admin");
    await service.addTeamMember({}, teamB.id, memberId, "member");

    sessionUserId = memberUserId;
    await expect(identity.getViewer({})).resolves.toMatchObject({
      role: "member",
      teamAdmin: true,
    });
    expect((await service.listTeams({})).teams.map((team) => team.id)).toEqual([
      teamA.id,
    ]);
    await expect(service.getTeam({}, teamA.id)).resolves.toMatchObject({
      id: teamA.id,
    });
    await expect(service.getTeam({}, teamB.id)).rejects.toMatchObject({
      code: "team_admin_required",
      statusCode: 403,
    });
    await expect(
      service.addTeamMember({}, teamA.id, secondMemberId, "member"),
    ).resolves.toMatchObject({ memberId: secondMemberId });
    await expect(
      service.addTeamMember({}, teamB.id, secondMemberId, "member"),
    ).rejects.toMatchObject({ code: "team_admin_required" });
  });

  it("lets only the owner demote administrators, even when admins race each other", async () => {
    await pool.query("UPDATE member SET role = 'admin' WHERE id = $1", [memberId]);
    const identityFor = (userId: string) =>
      new IdentityService(
        pool,
        {
          api: {
            getSession: async () => ({
              session: { id: `session-${userId}`, userId },
              user: { id: userId },
            }),
          },
        } as unknown as LoriAuth,
        config,
      );

    // Two administrators without an owner cannot demote each other.
    const peers = await Promise.allSettled([
      identityFor(adminUserId).updateMemberRole({}, memberId, "member"),
      identityFor(memberUserId).updateMemberRole({}, adminMemberId, "member"),
    ]);
    expect(peers.every((result) => result.status === "rejected")).toBe(true);
    for (const result of peers)
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        code: "owner_required",
      });

    // With an owner, the owner's demotion wins and the admin cannot touch the owner.
    await pool.query("UPDATE member SET role = 'owner' WHERE id = $1", [
      adminMemberId,
    ]);
    const results = await Promise.allSettled([
      identityFor(adminUserId).updateMemberRole({}, memberId, "member"),
      identityFor(memberUserId).updateMemberRole({}, adminMemberId, "member"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results[0]!.status).toBe("fulfilled");
    const roles = await pool.query<{ id: string; role: string }>(
      `SELECT id, role FROM member WHERE "organizationId" = $1 AND role <> 'member'`,
      [organizationId],
    );
    expect(roles.rows).toEqual([{ id: adminMemberId, role: "owner" }]);
    const revision = await pool.query<{ revision: string }>(
      "SELECT revision::text FROM organization_policies WHERE organization_id = $1",
      [organizationId],
    );
    expect(Number(revision.rows[0]?.revision)).toBe(2);
    await pool.query("UPDATE member SET role = 'admin' WHERE id = $1", [
      adminMemberId,
    ]);
  });

  it("advances the desktop revision when removing an organization member", async () => {
    const removableUserId = randomUUID();
    const removableMemberId = randomUUID();
    await pool.query(
      `
        INSERT INTO "user" (
          id, name, email, "emailVerified", "createdAt", "updatedAt"
        )
        VALUES ($1, 'Removable User', $2, TRUE, NOW(), NOW())
      `,
      [removableUserId, `${removableUserId}@example.com`],
    );
    await pool.query(
      `
        INSERT INTO member (
          id, "organizationId", "userId", role, "createdAt"
        )
        VALUES ($1, $2, $3, 'member', NOW())
      `,
      [removableMemberId, organizationId, removableUserId],
    );
    const removableDeviceId = randomUUID();
    const sourceId = randomUUID();
    await pool.query(
      `
        INSERT INTO devices (
          id, organization_id, user_id, name, platform, app_version
        ) VALUES ($1, $2, $3, 'Removable Mac', 'macos', '1.5.4')
      `,
      [removableDeviceId, organizationId, removableUserId],
    );
    await pool.query(
      `
        INSERT INTO usage_analytics_sources (
          id, organization_id, principal_id, collection_epoch,
          last_device_id, app_version
        ) SELECT $1, $2, principals.id, policies.usage_analytics_epoch, $3, '1.5.4'
          FROM organization_policies policies
          JOIN usage_analytics_principals principals
            ON principals.organization_id = policies.organization_id
           AND principals.member_id = $4
          WHERE policies.organization_id = $2
      `,
      [sourceId, organizationId, removableDeviceId, removableMemberId],
    );

    await identity.removeMember({}, removableMemberId);

    const revision = await pool.query<{ revision: string }>(
      "SELECT revision::text FROM organization_policies WHERE organization_id = $1",
      [organizationId],
    );
    expect(Number(revision.rows[0]?.revision)).toBe(2);
    const anonymized = await pool.query<{
      anonymized: boolean;
      display_name: string | null;
      email: string | null;
      member_id: string | null;
      user_id: string | null;
    }>(
      `
        SELECT principals.anonymized, principals.display_name, principals.email,
               principals.member_id, principals.user_id
        FROM usage_analytics_sources sources
        JOIN usage_analytics_principals principals
          ON principals.id = sources.principal_id
         AND principals.organization_id = sources.organization_id
        WHERE sources.id = $1 AND sources.organization_id = $2
      `,
      [sourceId, organizationId],
    );
    expect(anonymized.rows[0]).toEqual({
      anonymized: true,
      display_name: null,
      email: null,
      member_id: null,
      user_id: null,
    });
  });

  it("enforces the organization boundary for team memberships in PostgreSQL", async () => {
    const team = await service.createTeam(
      {},
      { name: "Tenant Boundary", slug: "tenant-boundary" },
    );
    const foreignOrganizationId = randomUUID();
    const foreignUserId = randomUUID();
    const foreignMemberId = randomUUID();
    await pool.query(
      `
        INSERT INTO "user" (
          id, name, email, "emailVerified", "createdAt", "updatedAt"
        )
        VALUES ($1, 'Foreign Member', $2, TRUE, NOW(), NOW())
      `,
      [foreignUserId, `${foreignUserId}@example.com`],
    );
    await pool.query(
      `
        INSERT INTO organization (id, name, slug, "createdAt")
        VALUES ($1, 'Foreign Organization', $2, NOW())
      `,
      [foreignOrganizationId, `foreign-${foreignOrganizationId}`],
    );
    await pool.query(
      `
        INSERT INTO member (
          id, "organizationId", "userId", role, "createdAt"
        )
        VALUES ($1, $2, $3, 'member', NOW())
      `,
      [foreignMemberId, foreignOrganizationId, foreignUserId],
    );

    await expect(
      pool.query(
        `
          INSERT INTO team_member (id, team_id, member_id, role)
          VALUES ($1, $2, $3, 'member')
        `,
        [randomUUID(), team.id, foreignMemberId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces optimistic concurrency and persists team-member overrides", async () => {
    const team = await service.createTeam(
      {},
      { name: "Engineering", slug: "engineering" },
    );
    await service.addTeamMember({}, team.id, memberId, "member");
    const initial = await service.getTeamPolicy({}, team.id);
    const updated = await service.updateTeamPolicy(
      {},
      team.id,
      initial.revision,
      { plugins: true, providers: false, skills: false },
      [{ enabled: true, id: "notion", type: "app" }],
    );
    expect(updated).toMatchObject({
      managedCatalog: [{ enabled: true, id: "notion", type: "app" }],
      organizationPersonalInstallations: {
        plugins: false,
        providers: false,
        skills: false,
      },
      personalInstallations: {
        plugins: true,
        providers: false,
        skills: false,
      },
    });
    await expect(
      service.updateTeamPolicy(
        {},
        team.id,
        initial.revision,
        updated.personalInstallations,
        updated.managedCatalog,
      ),
    ).rejects.toMatchObject({ code: "policy_revision_conflict" });

    const memberPolicy = await service.updateTeamMemberPolicy(
      {},
      team.id,
      memberId,
      updated.revision,
      {
        managedCatalog: [
          { enabled: false, id: "notion", type: "app" },
          { enabled: true, id: "openai", type: "provider" },
        ],
        personalInstallations: {
          plugins: false,
          providers: null,
          skills: null,
        },
      },
    );
    expect(memberPolicy.effective).toMatchObject({
      managedCatalog: [
        { enabled: false, id: "notion", type: "app" },
        { enabled: true, id: "openai", type: "provider" },
      ],
      personalInstallations: {
        plugins: false,
        providers: false,
        skills: false,
      },
    });

    const membership = await pool.query<{ id: string }>(
      "SELECT id FROM team_member WHERE team_id = $1 AND member_id = $2",
      [team.id, memberId],
    );
    await service.removeTeamMember({}, team.id, membership.rows[0]!.id);
    const remaining = await pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM team_member_catalog_overrides
        WHERE team_member_id = $1
      `,
      [membership.rows[0]!.id],
    );
    expect(Number(remaining.rows[0]?.count)).toBe(0);
    const audit = await pool.query<{ action: string }>(
      `
        SELECT action
        FROM audit_events
        WHERE subject_id = $1
        ORDER BY created_at
      `,
      [team.id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "team.policy_updated",
        "team.member_policy_updated",
        "team.member_removed",
      ]),
    );
  });

  it("resolves real multi-team SQL contributions before global member overrides", async () => {
    const teamA = await service.createTeam(
      {},
      { name: "Frontend", slug: "frontend" },
    );
    const teamB = await service.createTeam(
      {},
      { name: "Experiments", slug: "experiments" },
    );
    await service.addTeamMember({}, teamA.id, memberId, "member");
    await service.addTeamMember({}, teamB.id, memberId, "member");

    const policyA = await service.getTeamPolicy({}, teamA.id);
    await service.updateTeamPolicy(
      {},
      teamA.id,
      policyA.revision,
      { plugins: true, providers: false, skills: false },
      [{ enabled: true, id: "notion", type: "app" }],
    );
    const policyB = await service.getTeamPolicy({}, teamB.id);
    const updatedB = await service.updateTeamPolicy(
      {},
      teamB.id,
      policyB.revision,
      { plugins: false, providers: false, skills: true },
      [
        { enabled: true, id: "linear", type: "app" },
        { enabled: true, id: "notion", type: "app" },
      ],
    );
    await service.updateTeamMemberPolicy(
      {},
      teamB.id,
      memberId,
      updatedB.revision,
      {
        managedCatalog: [
          { enabled: false, id: "notion", type: "app" },
        ],
        personalInstallations: {
          plugins: null,
          providers: null,
          skills: false,
        },
      },
    );

    sessionUserId = memberUserId;
    const teamEffective = await enrollment.getPolicy({});
    expect(teamEffective).toMatchObject({
      managedCatalog: [
        { enabled: true, id: "linear", type: "app" },
        { enabled: true, id: "notion", type: "app" },
      ],
      personalInstallations: {
        plugins: true,
        providers: false,
        skills: false,
      },
      personalInstallationAttribution: {
        plugins: {
          source: "team",
          teams: [
            { id: teamA.id, name: "Frontend", slug: "frontend" },
          ],
        },
        providers: { source: "organization" },
        skills: { source: "organization" },
      },
    });

    sessionUserId = adminUserId;
    const inspected = await service.getTeamMemberPolicy(
      {},
      teamA.id,
      memberId,
    );
    expect(inspected.teamContribution.managedCatalog).toEqual([
      { enabled: true, id: "notion", type: "app" },
    ]);
    expect(inspected.finalEffective.managedCatalog).toEqual([
      { enabled: true, id: "linear", type: "app" },
      { enabled: true, id: "notion", type: "app" },
    ]);

    const globallyOverridden = await enrollment.updateMemberPolicy(
      {},
      memberId,
      teamEffective.revision,
      {
        managedCatalog: [
          { enabled: false, id: "notion", type: "app" },
        ],
        personalInstallations: {
          plugins: false,
          providers: null,
          skills: null,
        },
      },
    );
    expect(globallyOverridden.effective).toMatchObject({
      managedCatalog: [
        { enabled: true, id: "linear", type: "app" },
        { enabled: false, id: "notion", type: "app" },
      ],
      personalInstallations: {
        plugins: false,
        providers: false,
        skills: false,
      },
      personalInstallationAttribution: {
        plugins: { source: "member_override" },
      },
    });
    expect(globallyOverridden.inherited).toMatchObject({
      managedCatalog: [
        { enabled: true, id: "linear", type: "app" },
        { enabled: true, id: "notion", type: "app" },
      ],
      personalInstallations: {
        plugins: true,
        providers: false,
        skills: false,
      },
    });
  });

  it("attributes organization access when a team has no matching grant", async () => {
    const team = await service.createTeam(
      {},
      { name: "Frontend Team", slug: "frontend-team" },
    );
    await service.addTeamMember({}, team.id, memberId, "member");
    const organizationPolicy = await enrollment.getOrganizationPolicy({});
    await enrollment.updatePolicy(
      {},
      organizationPolicy.revision,
      { plugins: false, providers: false, skills: true },
      [],
    );

    sessionUserId = memberUserId;
    const effective = await enrollment.getPolicy({});

    expect(effective.personalInstallations.skills).toBe(true);
    expect(effective.personalInstallationAttribution?.skills).toEqual({
      source: "organization",
    });
    sessionUserId = adminUserId;
    expect((await service.getTeamPolicy({}, team.id)).personalInstallations.skills)
      .toBe(false);
  });
});
