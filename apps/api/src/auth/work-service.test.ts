import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  EnterpriseWorkPolicy,
  WorkPolicyInput,
  WorkMemberPolicy,
} from "@lori-enterprise/contracts";
import type { AppConfig } from "../config.js";
import type { LoriAuth } from "./auth.js";
import { IdentityService } from "./identity-service.js";
import { EnrollmentService } from "./enrollment-service.js";
import { TeamService } from "./team-service.js";
import { ProviderGatewayService } from "./provider-gateway-service.js";
import { UsageAnalyticsService } from "../usage/service.js";
import { buildApp } from "../app.js";
import { generateDesktopToken, hashDesktopToken } from "./desktop-tokens.js";
import {
  WorkService,
  applyWorkOverrides,
  unionWorkPolicies,
  defaultWorkPolicy,
  emptyWorkOverrides,
} from "./work-service.js";
import { workCatalog, validateWorkCatalog } from "./work-catalog.js";

describe("Work policy semantics", () => {
  it("retains explicit organization exclusions until another team grants them, then applies member overrides", () => {
    const org = {
      ...defaultWorkPolicy(),
      managedCatalog: [
        { type: "skill" as const, id: "research", enabled: false },
      ],
      providerModels: [{ providerId: "openai", modelIds: ["org-model"] }],
    };
    expect(unionWorkPolicies(org, []).managedCatalog).toEqual(
      org.managedCatalog,
    );
    const team = {
      ...defaultWorkPolicy(),
      managedCatalog: [
        { type: "skill" as const, id: "research", enabled: true },
      ],
      providerModels: [{ providerId: "openai", modelIds: ["team-model"] }],
    };
    const inherited = unionWorkPolicies(org, [team]);
    expect(inherited.managedCatalog[0]?.enabled).toBe(true);
    expect(inherited.providerModels[0]?.modelIds).toEqual([
      "org-model",
      "team-model",
    ]);
    const overrides = {
      ...emptyWorkOverrides(),
      enabled: false,
      managedCatalog: [
        { type: "skill" as const, id: "research", enabled: false },
      ],
      providerModels: [
        { providerId: "openai", modelId: "org-model", enabled: false },
      ],
    };
    const effective = applyWorkOverrides(inherited, overrides);
    expect(effective.enabled).toBe(false);
    expect(effective.managedCatalog[0]?.enabled).toBe(false);
    expect(effective.providerModels[0]?.modelIds).toEqual(["team-model"]);
  });
  it("retains empty model restrictions after the last grant is removed and team exclusions without grants", () => {
    const base = {
      ...defaultWorkPolicy(),
      providerModels: [{ providerId: "openai", modelIds: ["only-model"] }],
    };
    const effective = applyWorkOverrides(base, {
      ...emptyWorkOverrides(),
      providerModels: [
        { providerId: "openai", modelId: "only-model", enabled: false },
      ],
    });
    expect(effective.providerModels).toEqual([
      { providerId: "openai", modelIds: [] },
    ]);
    const team = {
      ...defaultWorkPolicy(),
      managedCatalog: [
        { type: "skill" as const, id: "documents", enabled: false },
      ],
    };
    expect(
      unionWorkPolicies(defaultWorkPolicy(), [team]).managedCatalog,
    ).toEqual(team.managedCatalog);
  });
  it("uses the Work plugin/skill manifest instead of Code catalog identities", () => {
    expect(
      workCatalog.items
        .filter((i) => i.type === "skill")
        .map((i) => i.id)
        .sort(),
    ).toEqual([
      "documents",
      "knowledge-capture",
      "meeting-preparation",
      "pdfs",
      "presentations",
      "project-planning",
      "research",
      "spreadsheets",
    ]);
    expect(() =>
      validateWorkCatalog([{ type: "skill", id: "documents", enabled: true }]),
    ).not.toThrow();
    expect(() =>
      validateWorkCatalog([
        { type: "skill", id: "typescript-advanced-types", enabled: true },
      ]),
    ).toThrow();
    expect(() =>
      validateWorkCatalog([
        { type: "plugin", id: "notion", enabled: true },
        { type: "plugin", id: "notion", enabled: false },
      ]),
    ).toThrow();
  });
});
const integrationDescribe =
  process.env.LORI_TEAM_INTEGRATION_TEST === "1" ? describe : describe.skip;
integrationDescribe("Work governance PostgreSQL integration", () => {
  const schema = `work_test_${randomUUID().replaceAll("-", "")}`;
  const orgId = "work-org";
  const deviceId = "10000000-0000-4000-8000-000000000001";
  const sessionId = "20000000-0000-4000-8000-000000000001";
  const epoch = "30000000-0000-4000-8000-000000000001";
  let pool: Pool;
  let adminPool: Pool;
  let actor = "admin";
  let work: WorkService;
  let teams: TeamService;
  let gateway: ProviderGatewayService;
  let usage: UsageAnalyticsService;
  let app: ReturnType<typeof buildApp>;
  let token: string;
  const config: AppConfig = {
    auth: {
      secret: "work-test-auth-secret-at-least-32-characters",
      secureCookies: false,
      setupToken: "work-test-setup-token-at-least-32-characters",
    },
    gateway: { secret: "work-test-gateway-secret-at-least-32-characters" },
    database: {
      host: process.env.DATABASE_HOST ?? "127.0.0.1",
      port: Number(process.env.DATABASE_PORT ?? 55432),
      name: process.env.DATABASE_NAME ?? "lori_enterprise",
      user: process.env.DATABASE_USER ?? "lori",
      password:
        process.env.DATABASE_PASSWORD ??
        "development-database-password-change-me",
      ssl: false,
    },
    environment: "test",
    host: "127.0.0.1",
    port: 4000,
    logLevel: "silent",
    publicUrl: "https://lori.example.com",
    trustProxy: false,
    version: "test",
  };
  beforeAll(async () => {
    const db = {
      host: config.database.host,
      port: config.database.port,
      database: config.database.name,
      user: config.database.user,
      password: config.database.password,
    };
    adminPool = new Pool(db);
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...db, options: `-c search_path=${schema},public` });
    const migrations = resolve(import.meta.dirname, "../../migrations");
    for (const name of readdirSync(migrations)
      .filter((n) => /^\d+_[a-z0-9_]+\.sql$/.test(n))
      .sort())
      await pool.query(readFileSync(resolve(migrations, name), "utf8"));
    await pool.query(
      `INSERT INTO "user"(id,name,email,"createdAt","updatedAt") VALUES ('admin','Admin','admin@test.local',NOW(),NOW()),('member','Member','member@test.local',NOW(),NOW()),('other','Other','other@test.local',NOW(),NOW()); INSERT INTO organization(id,name,slug,"createdAt") VALUES ('work-org','Work Org','work-org',NOW()),('other-org','Other','other-org',NOW());INSERT INTO organization_policies(organization_id,usage_analytics_epoch,usage_analytics_started_at) VALUES ('work-org','${epoch}','2026-01-01T00:00:00Z'),('other-org',gen_random_uuid(),NOW());INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES ('admin-member','work-org','admin','admin',NOW()),('work-member','work-org','member','member',NOW()),('other-member','other-org','other','admin',NOW());INSERT INTO team(id,organization_id,name,slug) VALUES ('work-team','work-org','Work Team','work-team'),('other-team','other-org','Other Team','other-team');INSERT INTO team_member(id,team_id,member_id,role) VALUES ('team-admin','work-team','admin-member','team_admin'),('team-member','work-team','work-member','member');`,
    );
    const auth = {
      api: {
        getSession: async () => ({
          session: { id: "browser-session", userId: actor },
          user: { id: actor },
        }),
      },
    } as unknown as LoriAuth;
    const enrollment = new EnrollmentService(pool, auth, config);
    const identity = new IdentityService(pool, auth, config);
    teams = new TeamService(pool, auth, config, enrollment);
    work = new WorkService(pool, identity, teams, enrollment);
    gateway = new ProviderGatewayService(pool, auth, config, enrollment, work);
    usage = new UsageAnalyticsService(pool, identity, enrollment, work);
    app = buildApp({
      config,
      database: { check: async () => true, close: async () => {} },
      identity,
      enrollment,
      teamService: teams,
      providerGateway: gateway,
      usageAnalytics: usage,
      work,
      pool,
    });
  }, 30000);
  beforeEach(async () => {
    actor = "admin";
    await pool.query("UPDATE member SET role='admin' WHERE id='admin-member'");
    await pool.query(
      "DELETE FROM member_work_policy_overrides;DELETE FROM team_member_work_policy_overrides;DELETE FROM team_work_policies;DELETE FROM organization_work_policies;DELETE FROM organization_provider_gateways;DELETE FROM organization_catalog_policies;DELETE FROM audit_events;DELETE FROM usage_analytics_sources;DELETE FROM device_refresh_tokens;DELETE FROM device_sessions;DELETE FROM devices;UPDATE organization_policies SET revision=1;",
    );
    await pool.query(
      "INSERT INTO organization_work_policies(organization_id) SELECT id FROM organization",
    );
    token = generateDesktopToken("access");
    await pool.query(
      `INSERT INTO devices(id,organization_id,user_id,name,platform,app_version,created_at) VALUES ($1,$2,'member','Work device','macos','test','2026-01-01T00:00:00Z');`,
      [deviceId, orgId],
    );
    await pool.query(
      "INSERT INTO device_sessions(id,device_id,token_family_id,access_token_hash,access_expires_at) VALUES ($1,$2,$1,$3,NOW()+INTERVAL '15 minutes')",
      [
        sessionId,
        deviceId,
        hashDesktopToken(token, config.auth.secret, "access"),
      ],
    );
    await pool.query(
      "INSERT INTO device_refresh_tokens(id,session_id,token_hash,expires_at) VALUES (gen_random_uuid(),$1,'refresh-hash',NOW()+INTERVAL '30 days')",
      [sessionId],
    );
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminPool.end();
    }
  });
  const revision = async () =>
    Number(
      (
        await pool.query(
          "SELECT revision FROM organization_policies WHERE organization_id=$1",
          [orgId],
        )
      ).rows[0].revision,
    );
  const updateOrg = async (policy: WorkPolicyInput) =>
    work.update({}, {}, await revision(), policy);
  it("fails closed on missing or malformed persisted Work authority", async () => {
    await pool.query(
      "DELETE FROM organization_work_policies WHERE organization_id=$1",
      [orgId],
    );
    await expect(
      work.effectiveForMember(orgId, "work-member"),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "work_policy_unavailable",
    });
    await pool.query(
      "INSERT INTO organization_work_policies(organization_id,policy) VALUES ($1,'{}'::jsonb)",
      [orgId],
    );
    await expect(
      work.effectiveForMember(orgId, "work-member"),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "work_policy_unavailable",
    });
  });
  it("defaults enabled, propagates shared revision and preserves Code policy while unioning team/member models", async () => {
    expect(await work.effectiveForMember(orgId, "work-member")).toMatchObject({
      ...defaultWorkPolicy(),
      schemaVersion: 1,
    });
    await updateOrg({
      ...defaultWorkPolicy(),
      managedCatalog: [{ type: "skill", id: "documents", enabled: false }],
      providerModels: [{ providerId: "openai", modelIds: ["org-model"] }],
    });
    await work.update({}, { teamId: "work-team" }, await revision(), {
      ...defaultWorkPolicy(),
      managedCatalog: [{ type: "skill", id: "documents", enabled: true }],
      providerModels: [{ providerId: "openai", modelIds: ["team-model"] }],
    });
    await work.update({}, { memberId: "work-member" }, await revision(), {
      ...emptyWorkOverrides(),
      providerModels: [
        { providerId: "openai", modelId: "org-model", enabled: false },
      ],
    });
    const effective = await work.effectiveForMember(orgId, "work-member");
    expect(effective.providerModels).toEqual([
      { providerId: "openai", modelIds: ["team-model"] },
    ]);
    expect(effective.managedCatalog).toEqual([
      { type: "skill", id: "documents", enabled: true },
    ]);
    expect(
      (
        await pool.query(
          "SELECT allow_personal_plugins FROM organization_policies WHERE organization_id=$1",
          [orgId],
        )
      ).rows[0].allow_personal_plugins,
    ).toBe(false);
    await expect(
      work.update({}, {}, 1, defaultWorkPolicy()),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("reads effective grants and their revision from one repeatable database snapshot", async () => {
    await updateOrg({
      ...defaultWorkPolicy(),
      providerModels: [{ providerId: "openai", modelIds: ["before"] }],
    });
    const before = await revision();
    type OrganizationRead = (
      organizationId: string,
      database: Pool | PoolClient,
    ) => Promise<WorkPolicyInput>;
    const original: OrganizationRead = Reflect.get(work, "organization").bind(
      work,
    );
    const internal = work as unknown as { organization: OrganizationRead };
    const spy = vi.spyOn(internal, "organization");
    spy.mockImplementationOnce(async (org, database) => {
      const captured = await original(org, database);
      await work.update({}, {}, before, {
        ...defaultWorkPolicy(),
        providerModels: [{ providerId: "openai", modelIds: ["after"] }],
      });
      return captured;
    });
    try {
      const captured = await work.effectiveForMember(orgId, "work-member");
      expect(captured.revision).toBe(before);
      expect(captured.providerModels).toEqual([
        { providerId: "openai", modelIds: ["before"] },
      ]);
      expect(
        (await work.effectiveForMember(orgId, "work-member")).providerModels,
      ).toEqual([{ providerId: "openai", modelIds: ["after"] }]);
    } finally {
      spy.mockRestore();
    }
  });
  it("returns the canonical team policy after saving through a team slug", async () => {
    await pool.query("UPDATE team SET slug='work-alias' WHERE id='work-team'");
    const read = vi.spyOn(work, "read");
    try {
      await work.update(
        {},
        { teamId: "work-alias" },
        await revision(),
        defaultWorkPolicy(),
      );
      expect(read).toHaveBeenLastCalledWith(
        {},
        { teamId: "work-team", memberId: undefined },
      );
    } finally {
      read.mockRestore();
      await pool.query("UPDATE team SET slug='work-team' WHERE id='work-team'");
    }
  });
  it("revalidates canonical team identity after a slug replacement and administrator reassignment", async () => {
    await pool.query(
      "UPDATE member SET role='member' WHERE id='admin-member'; UPDATE team SET slug='work-alias' WHERE id='work-team'",
    );
    const original = teams.assertTeamAdmin.bind(teams);
    const spy = vi.spyOn(teams, "assertTeamAdmin");
    spy.mockImplementationOnce(async (headers, identifier, database) => {
      const authorized = await original(headers, identifier, database);
      await pool.query(
        "UPDATE team SET slug='renamed-team' WHERE id='work-team'; INSERT INTO team(id,organization_id,name,slug) VALUES ('replacement-team','work-org','Replacement','work-alias'); UPDATE team_member SET role='member' WHERE id='team-admin'; INSERT INTO team_member(id,team_id,member_id,role) VALUES ('replacement-admin','replacement-team','admin-member','team_admin')",
      );
      return authorized;
    });
    try {
      await expect(
        work.update(
          {},
          { teamId: "work-alias" },
          await revision(),
          defaultWorkPolicy(),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(spy.mock.calls[1]?.[1]).toBe("work-team");
    } finally {
      spy.mockRestore();
      await pool.query(
        "DELETE FROM team WHERE id='replacement-team'; UPDATE team SET slug='work-team' WHERE id='work-team'; UPDATE team_member SET role='team_admin' WHERE id='team-admin'",
      );
    }
  });
  it("confines team admins to their teams and prevents tenant/member cross-assignment", async () => {
    await pool.query("UPDATE member SET role='member' WHERE id='admin-member'");
    await expect(
      work.update({}, {}, await revision(), defaultWorkPolicy()),
    ).rejects.toMatchObject({ statusCode: 403 });
    await work.update(
      {},
      { teamId: "work-team", memberId: "work-member" },
      await revision(),
      { ...emptyWorkOverrides(), enabled: false },
    );
    expect(
      (
        (await work.read(
          {},
          { teamId: "work-team", memberId: "work-member" },
        )) as WorkMemberPolicy
      ).finalEffective?.enabled,
    ).toBe(true); // org grant wins team-local exclusion
    await expect(
      work.update(
        {},
        { teamId: "other-team" },
        await revision(),
        defaultWorkPolicy(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      work.update(
        {},
        { teamId: "work-team", memberId: "other-member" },
        await revision(),
        emptyWorkOverrides(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  it("configures shared company keys inside Work without creating or replacing Code model grants", async () => {
    const headers = { origin: config.publicUrl };
    expect(await gateway.listWorkOrganizationGateways({})).toEqual({
      providerGateways: [],
      revision: 1,
    });
    const secret = "work-company-key-secret";
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/work/provider-gateways",
      headers,
      payload: {
        providerId: "openai",
        apiKey: secret,
        expectedRevision: 1,
        requestsPerMinute: 40,
      },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json();
    expect(created).toMatchObject({
      providerId: "openai",
      credentialConfigured: true,
      requestsPerMinute: 40,
      policyRevision: 2,
    });
    expect(created).not.toHaveProperty("enabledModels");
    expect(response.body).not.toContain(secret);
    const row = (
      await pool.query(
        "SELECT enabled_models,encrypted_api_key FROM organization_provider_gateways WHERE id=$1",
        [created.id],
      )
    ).rows[0];
    expect(row.enabled_models).toEqual([]);
    expect(row.encrypted_api_key).not.toContain(secret);
    expect(
      (await work.effectiveForMember(orgId, "work-member")).managedCatalog,
    ).toEqual([]);
    await pool.query(
      "INSERT INTO organization_catalog_policies(organization_id,item_type,item_id,enabled) VALUES ($1,'provider','openai',TRUE)",
      [orgId],
    );
    expect(await gateway.desktopGatewayMetadata(`Bearer ${token}`)).toEqual([]);
    expect(
      (await gateway.desktopCredentials(`Bearer ${token}`)).providers,
    ).toEqual([]);
    await updateOrg({
      ...defaultWorkPolicy(),
      managedCatalog: [{ type: "provider", id: "openai", enabled: true }],
      providerModels: [{ providerId: "openai", modelIds: ["work-model"] }],
    });
    expect(
      (await gateway.desktopWorkGatewayMetadata(`Bearer ${token}`))[0]
        ?.enabledModels,
    ).toEqual(["work-model"]);
    const code = await gateway.updateOrganizationGateway({}, created.id, {
      expectedRevision: await revision(),
      enabledModels: ["code-model"],
    });
    expect(code.enabledModels).toEqual(["code-model"]);
    const rotated = await app.inject({
      method: "PATCH",
      url: `/v1/admin/work/provider-gateways/${created.id}`,
      headers,
      payload: {
        apiKey: "rotated-company-key",
        requestsPerMinute: 25,
        expectedRevision: await revision(),
      },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).not.toHaveProperty("enabledModels");
    expect(
      (
        await pool.query(
          "SELECT enabled_models FROM organization_provider_gateways WHERE id=$1",
          [created.id],
        )
      ).rows[0].enabled_models,
    ).toEqual(["code-model"]);
    expect(
      (await gateway.desktopWorkGatewayMetadata(`Bearer ${token}`))[0]
        ?.enabledModels,
    ).toEqual(["work-model"]);
    const listing = await gateway.listWorkOrganizationGateways({});
    expect(listing.revision).toBe(await revision());
    expect(listing.providerGateways[0]?.policyRevision).toBe(listing.revision);
    await expect(
      gateway.createOrganizationGateway(
        {},
        {
          apiKey: "code-key",
          providerId: "anthropic",
          enabledModels: [],
          requestsPerMinute: 60,
          expectedRevision: await revision(),
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_provider_models" });
  });
  it("requires organization admin, Work-supported providers and fresh revision for company keys", async () => {
    actor = "member";
    await expect(
      gateway.listWorkOrganizationGateways({}),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      gateway.createWorkOrganizationGateway(
        {},
        {
          providerId: "openai",
          apiKey: "company-key",
          requestsPerMinute: 60,
          expectedRevision: 1,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    actor = "admin";
    await expect(
      gateway.createWorkOrganizationGateway(
        {},
        {
          providerId: "vllm",
          apiKey: "company-key",
          requestsPerMinute: 60,
          expectedRevision: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_work_provider" });
    const created = await gateway.createWorkOrganizationGateway(
      {},
      {
        providerId: "openai",
        apiKey: "company-key",
        requestsPerMinute: 60,
        expectedRevision: 1,
      },
    );
    const current = await revision();
    await expect(
      gateway.updateWorkOrganizationGateway({}, created.id, {
        apiKey: "replacement",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await revision()).toBe(current);
    await expect(
      gateway.createWorkOrganizationGateway(
        {},
        {
          providerId: "openai",
          apiKey: "company-key",
          requestsPerMinute: 60,
          expectedRevision: current,
        },
      ),
    ).rejects.toMatchObject({ code: "provider_gateway_exists" });
    expect(await revision()).toBe(current);
    actor = "other";
    await expect(
      gateway.updateWorkOrganizationGateway({}, created.id, {
        apiKey: "replacement",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    actor = "admin";
    type Bump = (
      client: PoolClient,
      organizationId: string,
      expectedRevision: number,
      userId: string,
    ) => Promise<number>;
    const original: Bump = Reflect.get(gateway, "bumpPolicyRevision").bind(
      gateway,
    );
    const spy = vi.spyOn(
      gateway as unknown as { bumpPolicyRevision: Bump },
      "bumpPolicyRevision",
    );
    spy.mockImplementationOnce(async (client, org, expected, user) => {
      await pool.query(
        "UPDATE member SET role='member' WHERE id='admin-member'",
      );
      return original(client, org, expected, user);
    });
    try {
      await expect(
        gateway.updateWorkOrganizationGateway({}, created.id, {
          apiKey: "replacement",
          expectedRevision: current,
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(await revision()).toBe(current);
    } finally {
      spy.mockRestore();
      await pool.query(
        "UPDATE member SET role='admin' WHERE id='admin-member'",
      );
    }
  });
  it("delivers assigned OpenAI, plugins and skills through bootstrap and refreshes cache after shared key changes", async () => {
    const created = await gateway.createWorkOrganizationGateway(
      {},
      {
        providerId: "openai",
        apiKey: "delivery-test-key",
        requestsPerMinute: 60,
        expectedRevision: await revision(),
      },
    );
    const managedCatalog = [
      { type: "provider" as const, id: "openai", enabled: true },
      { type: "plugin" as const, id: "notion", enabled: true },
      { type: "skill" as const, id: "documents", enabled: true },
    ];
    await updateOrg({
      ...defaultWorkPolicy(),
      personalInstallations: {
        plugins: false,
        providers: false,
        skills: false,
      },
      managedCatalog,
      providerModels: [{ providerId: "openai", modelIds: ["xxxxxxxxxxx"] }],
    });
    const headers = {
      authorization: `Bearer ${token}`,
      "x-lori-protocol-version": "1",
    };
    const initial = await app.inject({
      method: "GET",
      url: "/v1/desktop/bootstrap",
      headers,
    });
    expect(initial.statusCode).toBe(200);
    const delivered = initial.json();
    expect(delivered.workPolicy.managedCatalog).toEqual(
      expect.arrayContaining(managedCatalog),
    );
    expect(delivered.workPolicy.providerModels).toEqual([
      { providerId: "openai", modelIds: ["xxxxxxxxxxx"] },
    ]);
    expect(delivered.managedCatalog).toEqual([]);
    expect(delivered.workManagedProviderGateways).toEqual([
      {
        gatewayId: created.id,
        providerId: "openai",
        name: "OpenAI",
        kind: "openai",
        enabledModels: ["xxxxxxxxxxx"],
        supportedAgents: ["work"],
        routeBaseUrls: {
          openai: `${config.publicUrl}/api/v1/work/provider-gateway/${created.id}/openai/v1`,
        },
      },
    ]);
    const credentials = await app.inject({
      method: "GET",
      url: "/v1/desktop/work/provider-credentials",
      headers,
    });
    expect(credentials.statusCode).toBe(200);
    const issued = credentials.json().providers;
    expect(issued).toHaveLength(1);
    expect(issued[0].gatewayId).toBe(created.id);
    expect(issued[0].token).toMatch(/^lpg1\./);
    expect(credentials.body).not.toContain("delivery-test-key");
    expect(Date.parse(issued[0].expiresAt)).toBeGreaterThan(Date.now());
    await gateway.updateWorkOrganizationGateway({}, created.id, {
      apiKey: "rotated-delivery-key",
      expectedRevision: await revision(),
    });
    const refreshed = await app.inject({
      method: "GET",
      url: "/v1/desktop/bootstrap",
      headers: { ...headers, "if-none-match": initial.headers.etag! },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.headers.etag).not.toBe(initial.headers.etag);
    expect(refreshed.json().workManagedProviderGateways).toEqual(
      delivered.workManagedProviderGateways,
    );
    const target = await gateway.authorizeGatewayRequest(
      `Bearer ${issued[0].token}`,
      created.id,
      "openai",
      "work",
    );
    expect(target.allowedModels).toEqual(["xxxxxxxxxxx"]);
    expect(target.apiKey).toBe("rotated-delivery-key");
    await updateOrg({
      ...defaultWorkPolicy(),
      personalInstallations: {
        plugins: false,
        providers: false,
        skills: false,
      },
      managedCatalog: managedCatalog.map((item) => ({
        ...item,
        enabled: item.type === "provider",
      })),
      providerModels: [{ providerId: "openai", modelIds: [] }],
    });
    const denied = await app.inject({
      method: "GET",
      url: "/v1/desktop/bootstrap",
      headers,
    });
    expect(denied.json().workManagedProviderGateways[0]).toMatchObject({
      gatewayId: created.id,
      enabledModels: [],
    });
    expect(denied.json().workPolicy.managedCatalog).toEqual(
      expect.arrayContaining([
        { type: "plugin", id: "notion", enabled: false },
        { type: "skill", id: "documents", enabled: false },
      ]),
    );
    expect(
      (await gateway.desktopWorkCredentials(`Bearer ${token}`)).providers,
    ).toEqual([]);
    const rejected = await app.inject({
      method: "POST",
      url: `/v1/work/provider-gateway/${created.id}/openai/v1/chat/completions`,
      headers: { authorization: `Bearer ${issued[0].token}` },
      payload: { model: "xxxxxxxxxxx", stream: true },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error).toBe("provider_gateway_model_denied");
  });
  it("keeps assignments visible without inventing a company connection when its key is not configured", async () => {
    await updateOrg({
      ...defaultWorkPolicy(),
      personalInstallations: {
        plugins: false,
        providers: false,
        skills: false,
      },
      managedCatalog: [{ type: "provider", id: "openai", enabled: true }],
      providerModels: [
        { providerId: "openai", modelIds: ["assigned-before-key"] },
      ],
    });
    const headers = {
      authorization: `Bearer ${token}`,
      "x-lori-protocol-version": "1",
    };
    const bootstrap = await app.inject({
      method: "GET",
      url: "/v1/desktop/bootstrap",
      headers,
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().workPolicy.providerModels).toEqual([
      { providerId: "openai", modelIds: ["assigned-before-key"] },
    ]);
    expect(bootstrap.json().workManagedProviderGateways).toEqual([]);
    expect(
      (await gateway.desktopWorkCredentials(`Bearer ${token}`)).providers,
    ).toEqual([]);
    expect(
      (await work.catalog({})).connectedOrganizationProviderIds,
    ).not.toContain("openai");
    const created = await gateway.createWorkOrganizationGateway(
      {},
      {
        providerId: "openai",
        apiKey: "newly-configured-company-key",
        requestsPerMinute: 60,
        expectedRevision: await revision(),
      },
    );
    expect(
      (await gateway.desktopWorkGatewayMetadata(`Bearer ${token}`))[0],
    ).toMatchObject({
      gatewayId: created.id,
      enabledModels: ["assigned-before-key"],
    });
    expect(
      (await gateway.desktopWorkCredentials(`Bearer ${token}`)).providers,
    ).toHaveLength(1);
  });
  it("binds Work gateway credentials to product/session and enforces latest independent model grants", async () => {
    const configured = await gateway.createOrganizationGateway(
      {},
      {
        apiKey: "sk-test-company-key",
        enabledModels: ["code-model"],
        expectedRevision: await revision(),
        providerId: "openai",
        requestsPerMinute: 60,
      },
    );
    await updateOrg({
      ...defaultWorkPolicy(),
      managedCatalog: [{ type: "provider", id: "openai", enabled: true }],
      providerModels: [{ providerId: "openai", modelIds: ["work-model"] }],
    });
    const creds = await gateway.desktopWorkCredentials(`Bearer ${token}`);
    const credential = creds.providers[0]!;
    expect(
      await gateway.authorizeGatewayRequest(
        `Bearer ${credential.token}`,
        configured.id,
        "openai",
        "work",
      ),
    ).toMatchObject({ allowedModels: ["work-model"] });
    await expect(
      gateway.authorizeGatewayRequest(
        `Bearer ${credential.token}`,
        configured.id,
        "openai",
      ),
    ).rejects.toMatchObject({ code: "provider_gateway_product_denied" });
    expect(
      (await gateway.listOrganizationGateways({})).providerGateways[0]
        ?.enabledModels,
    ).toEqual(["code-model"]);
    await updateOrg({
      ...defaultWorkPolicy(),
      managedCatalog: [{ type: "provider", id: "openai", enabled: true }],
      providerModels: [{ providerId: "openai", modelIds: [] }],
    });
    expect(
      (await gateway.desktopWorkGatewayMetadata(`Bearer ${token}`))[0],
    ).toMatchObject({ providerId: "openai", enabledModels: [] });
    expect(
      (await gateway.desktopWorkCredentials(`Bearer ${token}`)).providers,
    ).toEqual([]);
    await updateOrg({
      ...defaultWorkPolicy(),
      managedCatalog: [{ type: "provider", id: "openai", enabled: true }],
      providerModels: [{ providerId: "openai", modelIds: ["work-model"] }],
    });
    await pool.query(
      "UPDATE device_sessions SET revoked_at=NOW() WHERE id=$1",
      [sessionId],
    );
    await expect(
      gateway.authorizeGatewayRequest(
        `Bearer ${credential.token}`,
        configured.id,
        "openai",
        "work",
      ),
    ).rejects.toMatchObject({ code: "provider_gateway_access_revoked" });
    await pool.query("UPDATE device_sessions SET revoked_at=NULL WHERE id=$1", [
      sessionId,
    ]);
    await updateOrg({ ...defaultWorkPolicy(), enabled: false });
    await expect(
      gateway.authorizeGatewayRequest(
        `Bearer ${credential.token}`,
        configured.id,
        "openai",
        "work",
      ),
    ).rejects.toMatchObject({ code: "work_disabled" });
  });
  it("separates Code/Work usage sources and rejects earlier enrollment windows and source rebinding", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const batch = {
      epoch,
      sourceId: randomUUID(),
      snapshots: [
        {
          agentId: "work-agent",
          appVersion: "test",
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costCoveredTokens: 0,
          estimatedCostMicrousd: 0,
          inputTokens: 42,
          outputTokens: 10,
          pricingVersion: "work-unpriced-v1",
          totalTurns: 1,
          usageDate: date,
        },
      ],
    };
    const enrolledAt = new Date(Date.now() - 1000).toISOString();
    await usage.ingest(`Bearer ${token}`, { ...batch, enrolledAt }, "work");
    await usage.ingest(`Bearer ${token}`, { ...batch, enrolledAt }, "work");
    await expect(usage.ingest(`Bearer ${token}`, batch)).rejects.toMatchObject({
      code: "usage_source_conflict",
    });
    await expect(
      usage.ingest(
        `Bearer ${token}`,
        { ...batch, enrolledAt: new Date(Date.now() - 500).toISOString() },
        "work",
      ),
    ).rejects.toMatchObject({ code: "usage_source_conflict" });
    const range = { agents: [], models: [], from: date, to: date };
    expect(
      (await usage.adminAnalytics({}, undefined, range)).totals.totalTokens,
    ).toBe(0);
    expect(
      (await usage.adminAnalytics({}, undefined, { ...range, product: "work" }))
        .totals.totalTokens,
    ).toBe(52);
    await expect(
      usage.ingest(
        `Bearer ${token}`,
        {
          ...batch,
          sourceId: randomUUID(),
          enrolledAt: "2025-01-01T00:00:00Z",
        },
        "work",
      ),
    ).rejects.toMatchObject({ code: "work_usage_enrollment_invalid" });
    await expect(
      usage.ingest(
        `Bearer ${token}`,
        {
          ...batch,
          sourceId: randomUUID(),
          enrolledAt,
          snapshots: [{ ...batch.snapshots[0]!, usageDate: "2026-01-02" }],
        },
        "work",
      ),
    ).rejects.toMatchObject({ code: "usage_date_out_of_range" });
  });
  it("changes bootstrap cache keys for Work schema and retries concurrent revision changes without revoking access", async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      "x-lori-protocol-version": "1",
      "if-none-match": '"lori-policy-v1-1"',
    };
    const first = await app.inject({
      method: "GET",
      url: "/v1/desktop/bootstrap",
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).not.toBe(headers["if-none-match"]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/desktop/bootstrap",
          headers: { ...headers, "if-none-match": first.headers.etag! },
        })
      ).statusCode,
    ).toBe(304);
    const actual = work.desktop.bind(work);
    const spy = vi.spyOn(work, "desktop");
    spy.mockImplementationOnce(async (auth) => ({
      ...(await actual(auth)),
      revision: 0,
    }));
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/desktop/bootstrap",
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockImplementation(async (auth) => ({
      ...(await actual(auth)),
      revision: 0,
    }));
    const conflict = await app.inject({
      method: "GET",
      url: "/v1/desktop/bootstrap",
      headers,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe("policy_sync_conflict");
    spy.mockRestore();
  });
  it("retains final accounting after Work is disabled but binds the source to its enrolled device", async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/work-rust-wire.json", import.meta.url),
        "utf8",
      ),
    );
    await usage.ingest(`Bearer ${token}`, fixture.usage, "work");
    await updateOrg({ ...defaultWorkPolicy(), enabled: false });
    const final = {
      ...fixture.usage,
      snapshots: [{ ...fixture.usage.snapshots[0], inputTokens: 30 }],
    };
    expect(
      (await usage.ingest(`Bearer ${token}`, final, "work")).accepted,
    ).toBe(1);
    const secondDevice = "10000000-0000-4000-8000-000000000002";
    const secondSession = "20000000-0000-4000-8000-000000000002";
    const secondToken = generateDesktopToken("access");
    await pool.query(
      "INSERT INTO devices(id,organization_id,user_id,name,platform,app_version,created_at) VALUES ($1,$2,'member','Second device','macos','test','2026-01-01T00:00:00Z')",
      [secondDevice, orgId],
    );
    await pool.query(
      "INSERT INTO device_sessions(id,device_id,token_family_id,access_token_hash,access_expires_at) VALUES ($1,$2,$1,$3,NOW()+INTERVAL '15 minutes')",
      [
        secondSession,
        secondDevice,
        hashDesktopToken(secondToken, config.auth.secret, "access"),
      ],
    );
    await expect(
      usage.ingest(`Bearer ${secondToken}`, final, "work"),
    ).rejects.toMatchObject({ code: "usage_source_conflict" });
    await pool.query(
      "UPDATE organization_policies SET usage_analytics_enabled=FALSE WHERE organization_id=$1",
      [orgId],
    );
    try {
      await expect(
        usage.ingest(`Bearer ${token}`, final, "work"),
      ).rejects.toMatchObject({ code: "usage_collection_disabled" });
    } finally {
      await pool.query(
        "UPDATE organization_policies SET usage_analytics_enabled=TRUE WHERE organization_id=$1",
        [orgId],
      );
    }
  });
  it("accepts the real Rust Chrono/serde wire fixture and totals exclusive input/cache counters", async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/work-rust-wire.json", import.meta.url),
        "utf8",
      ),
    );
    expect(fixture.usage.enrolledAt).toBe("2026-08-11T01:00:00+00:00");
    expect(fixture.audit.events[0].occurredAt).toBe(
      "2026-08-11T01:30:00+00:00",
    );
    const headers = {
      authorization: `Bearer ${token}`,
      "x-lori-protocol-version": "1",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/desktop/work/usage",
          headers,
          payload: fixture.usage,
        })
      ).statusCode,
    ).toBe(200);
    const replay = {
      ...fixture.usage,
      enrolledAt: fixture.usage.enrolledAt.replace("+00:00", "Z"),
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/desktop/work/usage",
          headers,
          payload: replay,
        })
      ).statusCode,
    ).toBe(200);
    const totals = (
      await usage.adminAnalytics({}, undefined, {
        agents: [],
        models: [],
        from: "2026-08-11",
        to: "2026-08-11",
        product: "work",
      })
    ).totals;
    expect(totals.totalTokens).toBe(120);
    expect(totals.inputTokens).toBe(20);
    expect(totals.cacheReadTokens).toBe(80);
    expect(totals.totalTurns).toBe(1);
    for (let n = 0; n < 2; n++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/desktop/work/audit",
            headers,
            payload: fixture.audit,
          })
        ).statusCode,
      ).toBe(200);
    const audit = await pool.query(
      "SELECT metadata FROM audit_events WHERE action='work.turn_completed'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toMatchObject({
      modelId: "model+fast",
      occurredAt: "2026-08-11T01:30:00+00:00",
    });
  });
  it("isolates inventory and accepts only bounded content-free idempotent Work audit metadata", async () => {
    await pool.query(
      'UPDATE devices SET inventory=\'[{"id":"codex"}]\'::jsonb WHERE id=$1',
      [deviceId],
    );
    const headers = {
      authorization: `Bearer ${token}`,
      "x-lori-protocol-version": "1",
    };
    const body = {
      items: [],
      policyRevision: 1,
      syncError: null,
      syncStatus: "synced",
    };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/v1/desktop/work/inventory",
          headers,
          payload: body,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await pool.query("SELECT inventory FROM devices WHERE id=$1", [
          deviceId,
        ])
      ).rows[0].inventory,
    ).toEqual([{ id: "codex" }]);
    const event = {
      eventId: randomUUID(),
      action: "turn_completed",
      modelId: "model+fast",
      occurredAt: new Date().toISOString(),
      policyRevision: 1,
    };
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/desktop/work/audit",
            headers,
            payload: { events: [event] },
          })
        ).statusCode,
      ).toBe(200);
    expect(
      Number(
        (
          await pool.query(
            "SELECT COUNT(*) FROM audit_events WHERE action='work.turn_completed'",
          )
        ).rows[0].count,
      ),
    ).toBe(1);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/desktop/work/audit",
          headers,
          payload: { events: [{ ...event, prompt: "private conversation" }] },
        })
      ).statusCode,
    ).toBe(400);
    const bootstrap = await app.inject({
      method: "GET",
      url: "/v1/desktop/bootstrap",
      headers,
    });
    expect(bootstrap.json().workPolicy.schemaVersion).toBe(1);
    expect(bootstrap.json().workManagedProviderGateways).toEqual([]);
    expect(((await work.read({})) as EnterpriseWorkPolicy).revision).toBe(1);
  });
});
