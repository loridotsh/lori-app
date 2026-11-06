import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { AppConfig } from "../config.js";
import type { LoriAuth } from "./auth.js";
import { EnrollmentService } from "./enrollment-service.js";
import { IdentityService } from "./identity-service.js";
import { TeamService } from "./team-service.js";
import { WorkService, defaultWorkPolicy, emptyWorkOverrides } from "./work-service.js";
import { assignOrganizationOwner } from "./owner-assign.js";
import { ONBOARDING_COOKIE } from "./onboarding.js";

const integration =
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
      process.env.DATABASE_PASSWORD ?? "development-database-password-change-me",
    port: Number(process.env.DATABASE_PORT ?? 55432),
    ssl: false,
    user: process.env.DATABASE_USER ?? "lori",
  },
  environment: "test",
  gateway: { secret: "test-provider-gateway-secret-at-least-32-characters" },
  host: "127.0.0.1",
  logLevel: "silent",
  port: 4000,
  publicUrl: "https://lori.acme.com",
  trustProxy: false,
  version: "test",
};

const migrationDirectory = resolve(import.meta.dirname, "../../migrations");
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
  .sort();
const OWNERSHIP_MIGRATION = "041_organization_ownership_delegation.sql";

integration("Organization ownership and delegation (PostgreSQL)", () => {
  const schema = `ownership_test_${randomUUID().replaceAll("-", "")}`;
  const org = "organization-1";
  const people = {
    owner: { member: "member-owner", user: "user-owner" },
    admin: { member: "member-admin", user: "user-admin" },
    teamAdmin: { member: "member-team-admin", user: "user-team-admin" },
    member: { member: "member-plain", user: "user-plain" },
  } as const;
  const teamId = "team-1";
  let adminPool: Pool;
  let pool: Pool;
  let schemaCreated = false;
  let sessionUser: string = people.owner.user;
  let sessionCreatedAt = new Date();
  let reissuedToken = "";
  let identity: IdentityService;
  let cloudIdentity: IdentityService;
  let enrollment: EnrollmentService;
  let teams: TeamService;
  let work: WorkService;

  const addPerson = async (id: string, role: "admin" | "member") => {
    await pool.query(
      `INSERT INTO "user" (id, name, email, "createdAt", "updatedAt") VALUES ($1, $1, $2, NOW(), NOW())`,
      [`user-${id}`, `user-${id}@example.com`],
    );
    await pool.query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, NOW())`,
      [`member-${id}`, org, `user-${id}`, role],
    );
  };
  const asCurrentOwner = async () => {
    const owner = await pool.query<{ userId: string }>(
      `SELECT "userId" FROM member WHERE "organizationId" = $1 AND role = 'owner'`,
      [org],
    );
    sessionUser = owner.rows[0]!.userId;
    sessionCreatedAt = new Date();
  };
  const invitationStatus = async (id: string) =>
    (await pool.query<{ status: string }>("SELECT status FROM invitation WHERE id = $1", [id])).rows[0]?.status;

  const as = (key: keyof typeof people, fresh = true) => {
    sessionUser = people[key].user;
    sessionCreatedAt = fresh ? new Date() : new Date(Date.now() - 60 * 60 * 1000);
    return {};
  };
  const revision = async () =>
    Number(
      (
        await pool.query<{ revision: string }>(
          "SELECT revision::text FROM organization_policies WHERE organization_id = $1",
          [org],
        )
      ).rows[0]?.revision,
    );
  const role = async (memberId: string) =>
    (
      await pool.query<{ role: string }>("SELECT role FROM member WHERE id = $1", [
        memberId,
      ])
    ).rows[0]?.role;

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
    pool = new Pool({ ...poolConfig, options: `-c search_path=${schema},public` });
    // Apply everything before ownership, seed a pre-ownership organization, then upgrade.
    for (const file of migrationFiles.filter((name) => name < OWNERSHIP_MIGRATION))
      await pool.query(readFileSync(resolve(migrationDirectory, file), "utf8"));
    await pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES
        ($1, 'Olivia Owner', 'owner@example.com', TRUE, NOW(), NOW()),
        ($2, 'Adam Admin', 'admin@example.com', TRUE, NOW(), NOW()),
        ($3, 'Tara Team', 'team@example.com', TRUE, NOW(), NOW()),
        ($4, 'Mia Member', 'member@example.com', TRUE, NOW(), NOW())`,
      [people.owner.user, people.admin.user, people.teamAdmin.user, people.member.user],
    );
    await pool.query(
      `INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, 'Acme', 'acme', NOW())`,
      [org],
    );
    await pool.query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES
        ($1, $5, $6, 'admin', NOW() - INTERVAL '2 days'),
        ($2, $5, $7, 'admin', NOW() - INTERVAL '1 day'),
        ($3, $5, $8, 'member', NOW()),
        ($4, $5, $9, 'member', NOW())`,
      [
        people.owner.member, people.admin.member, people.teamAdmin.member, people.member.member,
        org, people.owner.user, people.admin.user, people.teamAdmin.user, people.member.user,
      ],
    );
    await pool.query("INSERT INTO organization_policies (organization_id) VALUES ($1)", [org]);
    await pool.query(
      "UPDATE deployment_setup SET completed_at = NOW(), organization_id = $1, admin_user_id = $2",
      [org, people.owner.user],
    );
    await pool.query(
      "INSERT INTO organization_work_policies (organization_id, policy) VALUES ($1, $2)",
      [org, JSON.stringify({ ...defaultWorkPolicy(), managedCatalog: [], providerModels: [] })],
    );
    await pool.query(
      "INSERT INTO team (id, organization_id, name, slug) VALUES ($1, $2, 'Research', 'research')",
      [teamId, org],
    );
    await pool.query(
      `INSERT INTO team_member (id, team_id, member_id, role) VALUES
        ('tm-team-admin', $1, $2, 'team_admin'), ('tm-member', $1, $3, 'member')`,
      [teamId, people.teamAdmin.member, people.member.member],
    );
    await pool.query("INSERT INTO team_policies (team_id) VALUES ($1)", [teamId]);
    // An existing team grant the migration must keep approved.
    await pool.query(
      "INSERT INTO team_catalog_policies (team_id, item_type, item_id, enabled) VALUES ($1, 'plugin', 'filesystem', TRUE)",
      [teamId],
    );
    await pool.query("INSERT INTO team_work_policies (team_id, policy) VALUES ($1, $2)", [
      teamId,
      JSON.stringify({
        ...defaultWorkPolicy(),
        enabled: true,
        personalInstallations: { plugins: false, providers: false, skills: false },
        managedCatalog: [{ type: "provider", id: "openai", enabled: true }],
        providerModels: [{ providerId: "openai", modelIds: ["team-model"] }],
      }),
    ]);
    for (const file of migrationFiles.filter((name) => name >= OWNERSHIP_MIGRATION))
      await pool.query(readFileSync(resolve(migrationDirectory, file), "utf8"));

    const auth = {
      api: {
        getSession: async () => ({
          session: { id: `session-${sessionUser}`, userId: sessionUser, createdAt: sessionCreatedAt },
          user: { id: sessionUser, email: `${sessionUser}@example.com`, name: sessionUser },
        }),
      },
    } as unknown as LoriAuth;
    identity = new IdentityService(pool, auth, config);
    cloudIdentity = new IdentityService(pool, auth, {
      ...config,
      auth: { ...config.auth, publicSignup: true },
    });
    enrollment = new EnrollmentService(pool, auth, config);
    teams = new TeamService(pool, auth, config, enrollment);
    work = new WorkService(pool, identity, teams, enrollment);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (schemaCreated) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("upgrades safely: promotes the setup admin, keeps existing team grants approved, and reports", async () => {
    expect(await role(people.owner.member)).toBe("owner");
    expect(await role(people.admin.member)).toBe("admin");
    const policies = await pool.query<{ delegation: unknown }>(
      "SELECT delegation FROM organization_work_policies WHERE organization_id = $1",
      [org],
    );
    expect(policies.rows[0]?.delegation).toMatchObject({
      version: 1,
      enabled: true,
      managedCatalog: [{ type: "provider", id: "openai" }],
      providerModels: [{ providerId: "openai", modelIds: ["team-model"] }],
    });
    const code = await pool.query<{ delegation: unknown }>(
      "SELECT delegation FROM organization_policies WHERE organization_id = $1",
      [org],
    );
    expect(code.rows[0]?.delegation).toMatchObject({
      managedCatalog: [{ type: "plugin", id: "filesystem" }],
    });
    // The team member keeps the team's Code plugin grant across the upgrade.
    const effective = await enrollment.effectivePolicyForMember(org, people.member.member);
    expect(effective.managedCatalog).toContainEqual({ enabled: true, id: "filesystem", type: "plugin" });
    const report = await pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action = 'permissions.migration_report' AND organization_id = $1",
      [org],
    );
    expect(report.rows[0]?.metadata).toMatchObject({ ownerAssigned: true, administrators: 2 });
    // Exactly one owner per organization is enforced by the database.
    await expect(
      pool.query("UPDATE member SET role = 'owner' WHERE id = $1", [people.admin.member]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("reports the owner and capabilities to the viewer, and the legacy role to desktops", async () => {
    as("owner");
    const owner = await identity.getViewer({});
    expect(owner.role).toBe("owner");
    expect(owner.authority?.capabilities).toContain("admins.manage");
    as("admin");
    const admin = await identity.getViewer({});
    expect(admin.authority?.capabilities).not.toContain("admins.manage");
    expect(admin.authority?.capabilities).toContain("members.manage");
  });

  it("reserves administrator appointments for the owner", async () => {
    as("admin");
    await expect(identity.createInvitation({}, "new-admin@example.com", "admin")).rejects.toMatchObject({
      code: "owner_required",
    });
    const memberInvite = await identity.createInvitation({}, "new-member@example.com", "member");
    expect(memberInvite.invitation.role).toBe("member");
    await expect(identity.updateMemberRole({}, people.member.member, "admin")).rejects.toMatchObject({
      code: "owner_required",
    });
    await expect(identity.updateMemberRole({}, people.owner.member, "member")).rejects.toMatchObject({
      code: "owner_protected",
    });
    await expect(identity.removeMember({}, people.owner.member)).rejects.toMatchObject({
      code: "owner_protected",
    });
    await expect(identity.updateMemberRole({}, people.admin.member, "member")).rejects.toMatchObject({
      code: "self_role_change",
    });

    as("owner");
    const adminInvite = await identity.createInvitation({}, "appointed@example.com", "admin");
    expect(adminInvite.invitation.role).toBe("admin");
    const token = adminInvite.url.split("/join/")[1]!;
    expect((await identity.previewJoin(token)).state).toBe("pending");
    await identity.updateMemberRole({}, people.member.member, "admin", await revision());
    expect(await role(people.member.member)).toBe("admin");
    await expect(identity.updateMemberRole({}, people.member.member, "member", 1)).rejects.toMatchObject({
      code: "access_revision_conflict",
    });
    await identity.updateMemberRole({}, people.member.member, "member");
    expect(await role(people.member.member)).toBe("member");
    // A removal reviewed against an older list is refused, like a role change.
    await expect(identity.removeMember({}, people.member.member, 1)).rejects.toMatchObject({
      code: "access_revision_conflict",
    });
    expect(await role(people.member.member)).toBe("member");
    await expect(identity.updateMemberRole({}, people.owner.member, "member")).rejects.toMatchObject({
      code: "self_role_change",
    });

    // Admins cannot withdraw or reissue the owner's administrator appointment.
    as("admin");
    await expect(identity.revokeInvitation({}, adminInvite.invitation.id)).rejects.toMatchObject({
      code: "owner_required",
    });
    await expect(identity.regenerateInvitation({}, adminInvite.invitation.id)).rejects.toMatchObject({
      code: "owner_required",
    });
  });

  it("transfers ownership atomically with recent sign-in and the reviewed revision", async () => {
    as("owner", false);
    await expect(
      identity.transferOwnership({}, people.admin.member, await revision()),
    ).rejects.toMatchObject({ code: "session_not_fresh" });
    as("owner");
    await expect(identity.transferOwnership({}, people.admin.member, 1)).rejects.toMatchObject({
      code: "access_revision_conflict",
    });
    await expect(
      identity.transferOwnership({}, people.owner.member, await revision()),
    ).rejects.toMatchObject({ code: "ownership_self_transfer" });
    as("admin");
    await expect(
      identity.transferOwnership({}, people.admin.member, await revision()),
    ).rejects.toMatchObject({ code: "owner_required" });

    const pending = await pool.query<{ id: string }>(
      "SELECT id FROM invitation WHERE email = 'appointed@example.com'",
    );
    as("owner");
    const result = await identity.transferOwnership({}, people.admin.member, await revision());
    expect(result).toMatchObject({ ownerMemberId: people.admin.member, previousOwnerMemberId: people.owner.member });
    expect(await role(people.admin.member)).toBe("owner");
    expect(await role(people.owner.member)).toBe("admin");
    const owners = await pool.query("SELECT 1 FROM member WHERE \"organizationId\" = $1 AND role = 'owner'", [org]);
    expect(owners.rowCount).toBe(1);
    // The former owner's administrator appointment lapses with their ownership.
    as("admin");
    const people_ = await identity.listPeople({});
    expect(people_.invitations.find((invite) => invite.id === pending.rows[0]!.id)?.state).toBe("revoked");
    // It is canceled outright, so it no longer blocks a fresh invitation or counts as pending.
    const lapsed = await pool.query<{ status: string }>("SELECT status FROM invitation WHERE id = $1", [pending.rows[0]!.id]);
    expect(lapsed.rows[0]?.status).toBe("canceled");
    // The new owner can reissue it under their own authority.
    sessionUser = people.admin.user;
    const reissued = await identity.regenerateInvitation({}, pending.rows[0]!.id);
    expect(reissued.invitation.state).toBe("pending");
    reissuedToken = reissued.url.split("/join/")[1]!;
    expect((await identity.previewJoin(reissuedToken)).state).toBe("pending");
    // Restore the original owner for the following tests.
    await identity.transferOwnership({}, people.owner.member, await revision());
    expect(await role(people.owner.member)).toBe("owner");
  });

  it("accepts an owner's admin invitation end to end and refuses one whose issuer lost ownership", async () => {
    // The appointment reissued above was made by an owner who has since handed ownership back.
    expect((await identity.previewJoin(reissuedToken)).state).toBe("revoked");
    await expect(identity.claimJoin(reissuedToken)).rejects.toMatchObject({ code: "invitation_unavailable" });

    as("owner");
    const invite = await identity.createInvitation({}, "joiner@example.com", "admin");
    const token = invite.url.split("/join/")[1]!;
    await pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('joiner', 'Jo Joiner', 'joiner@example.com', TRUE, NOW(), NOW())`,
    );
    const claim = await identity.claimJoin(token);
    sessionUser = "joiner";
    const viewer = await identity.acceptJoin(token, {}, `${ONBOARDING_COOKIE}=${claim}`);
    expect(viewer.role).toBe("admin");
    expect(viewer.authority?.capabilities).toContain("projects.administer");
    // Replaying the accepted link changes nothing.
    expect((await identity.acceptJoin(token, {}, `${ONBOARDING_COOKIE}=${claim}`)).role).toBe("admin");
    // The new admin can run the organization but not appoint admins.
    await expect(identity.createInvitation({}, "another-admin@example.com", "admin")).rejects.toMatchObject({ code: "owner_required" });
  });

  it("recovers ownership only for organizations without an owner", async () => {
    const client = await pool.connect();
    try {
      await expect(assignOrganizationOwner(client, "admin@example.com")).rejects.toThrow(/already has an owner/);
      await pool.query("UPDATE member SET role = 'admin' WHERE id = $1", [people.owner.member]);
      await expect(assignOrganizationOwner(client, "member@example.com")).rejects.toThrow(/existing administrator/);
      await assignOrganizationOwner(client, "owner@example.com");
      expect(await role(people.owner.member)).toBe("owner");
    } finally {
      client.release();
    }
  });

  it("bounds team grants by the organization's delegation ceiling", async () => {
    const team = await teams.getTeamPolicy((as("teamAdmin"), {}), teamId);
    expect(team.delegation?.managedCatalog).toContainEqual({ id: "filesystem", type: "plugin" });
    // A team administrator cannot grant a plugin the organization never approved.
    await expect(
      teams.updateTeamPolicy({}, teamId, team.revision, team.personalInstallations, [
        ...team.managedCatalog,
        { enabled: true, id: "postgres", type: "plugin" },
      ]),
    ).rejects.toMatchObject({ code: "delegation_not_approved" });
    // Saving the existing, approved grants unchanged still works.
    await teams.updateTeamPolicy({}, teamId, team.revision, { ...team.personalInstallations }, team.managedCatalog);

    // An organization administrator's explicit team grant approves it (audited).
    as("admin");
    const current = await teams.getTeamPolicy({}, teamId);
    const updated = await teams.updateTeamPolicy({}, teamId, current.revision, current.personalInstallations, [
      ...current.managedCatalog,
      { enabled: true, id: "postgres", type: "plugin" },
    ]);
    expect(updated.delegation?.managedCatalog).toContainEqual({ id: "postgres", type: "plugin" });

    // Narrowing the ceiling removes the team grant's effect without deleting it.
    const delegation = await enrollment.getCodeDelegation({});
    await enrollment.updateCodeDelegation({}, delegation.revision, {
      personalInstallations: delegation.personalInstallations,
      managedCatalog: delegation.managedCatalog.filter((item) => item.id !== "postgres"),
    });
    const effective = await enrollment.effectivePolicyForMember(org, people.member.member);
    expect(effective.managedCatalog.find((item) => item.id === "postgres")?.enabled ?? false).toBe(false);
    expect(effective.managedCatalog).toContainEqual({ enabled: true, id: "filesystem", type: "plugin" });
  });

  it("bounds Work team grants and gives administrators the approved Work resources", async () => {
    as("teamAdmin");
    const team = (await work.read({}, { teamId })) as Awaited<ReturnType<WorkService["effectiveForMember"]>>;
    expect(team.delegation?.providerModels).toEqual([{ providerId: "openai", modelIds: ["team-model"] }]);
    const { schemaVersion: _s, revision: rev, delegation: _d, ...input } = team;
    await expect(
      work.update({}, { teamId }, rev, {
        ...input,
        providerModels: [{ providerId: "openai", modelIds: ["team-model", "unapproved-model"] }],
      }),
    ).rejects.toMatchObject({ code: "delegation_not_approved" });

    // The team member gets the approved team model.
    const member = await work.effectiveForMember(org, people.member.member);
    expect(member.providerModels).toEqual([{ providerId: "openai", modelIds: ["team-model"] }]);

    // An administrator gets every approved resource without a team, and their own
    // member override cannot silently remove it.
    as("owner");
    const overrideRevision = await revision();
    await work.update({}, { memberId: people.admin.member }, overrideRevision, {
      ...emptyWorkOverrides(),
      enabled: false,
      providerModels: [{ providerId: "openai", modelId: "team-model", enabled: false }],
    });
    const admin = await work.effectiveForMember(org, people.admin.member);
    expect(admin.enabled).toBe(true);
    expect(admin.providerModels).toEqual([{ providerId: "openai", modelIds: ["team-model"] }]);
    // An ordinary member with the same override loses access.
    await work.update({}, { memberId: people.member.member }, await revision(), {
      ...emptyWorkOverrides(),
      enabled: false,
    });
    expect((await work.effectiveForMember(org, people.member.member)).enabled).toBe(false);
  });

  it("lets a new invitation replace an expired one", async () => {
    await asCurrentOwner();
    const first = await identity.createInvitation({}, "late@example.com", "member");
    await expect(identity.createInvitation({}, "late@example.com", "member")).rejects.toMatchObject({
      code: "invitation_exists",
    });
    await pool.query(`UPDATE invitation SET "expiresAt" = NOW() - INTERVAL '1 minute' WHERE id = $1`, [first.invitation.id]);
    const second = await identity.createInvitation({}, "late@example.com", "member");
    expect(second.invitation.id).not.toBe(first.invitation.id);
    expect(await invitationStatus(first.invitation.id)).toBe("canceled");
    expect(await invitationStatus(second.invitation.id)).toBe("pending");
  });

  it("cancels every invitation issued by someone who is removed", async () => {
    await addPerson("issuer", "admin");
    sessionUser = "user-issuer";
    const issued = await identity.createInvitation({}, "kept-out@example.com", "member");
    await asCurrentOwner();
    await identity.removeMember({}, "member-issuer");
    expect(await invitationStatus(issued.invitation.id)).toBe("canceled");
  });

  it("lets a member leave, through the same cleanup as removal", async () => {
    await addPerson("leaver", "member");
    await pool.query(
      `INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt", "userId", "activeOrganizationId")
       VALUES ('session-leaver', NOW() + INTERVAL '1 day', 'token-leaver', NOW(), NOW(), 'user-leaver', $1)`,
      [org],
    );
    sessionUser = "user-leaver";
    await expect(identity.leaveWorkspace({}, org)).rejects.toMatchObject({ code: "public_signup_disabled" });
    await expect(cloudIdentity.leaveWorkspace({}, "another-organization")).rejects.toMatchObject({
      code: "workspace_changed",
    });
    await expect(cloudIdentity.leaveWorkspace({}, org)).resolves.toEqual({ organization: null });
    expect((await pool.query("SELECT 1 FROM member WHERE id = 'member-leaver'")).rowCount).toBe(0);
    const session = await pool.query<{ organization: string | null }>(
      `SELECT "activeOrganizationId" AS organization FROM session WHERE id = 'session-leaver'`,
    );
    expect(session.rows).toEqual([{ organization: null }]);
    const audit = await pool.query("SELECT 1 FROM audit_events WHERE action = 'member.left' AND actor_user_id = 'user-leaver'");
    expect(audit.rowCount).toBe(1);
  });

  it("makes the Owner hand over before leaving", async () => {
    await asCurrentOwner();
    await expect(cloudIdentity.leaveWorkspace({}, org)).rejects.toMatchObject({ code: "owner_cannot_leave" });
  });
});
