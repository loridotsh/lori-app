import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { EnrollmentService } from "../auth/enrollment-service.js";
import type { IdentityError, IdentityService } from "../auth/identity-service.js";
import { UsageAnalyticsService } from "./service.js";

const integrationDescribe =
  process.env.LORI_USAGE_INTEGRATION_TEST === "1" ? describe : describe.skip;

integrationDescribe("UsageAnalyticsService PostgreSQL integration", () => {
  const schema = `usage_test_${randomUUID().replaceAll("-", "")}`;
  const epoch = "00000000-0000-4000-8000-000000000001";
  const sourceId = "00000000-0000-4000-8000-000000000002";
  const organizationId = "organization-usage";
  let adminPool: Pool;
  let pool: Pool;
  let service: UsageAnalyticsService;
  let activeMember = "member-one";

  beforeAll(async () => {
    const config = {
      database: process.env.DATABASE_NAME ?? "lori_enterprise",
      host: process.env.DATABASE_HOST ?? "127.0.0.1",
      password: process.env.DATABASE_PASSWORD ?? "development-database-password-change-me",
      port: Number(process.env.DATABASE_PORT ?? 55432),
      ssl: false,
      user: process.env.DATABASE_USER ?? "lori",
    };
    adminPool = new Pool(config);
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, options: `-c search_path=${schema},public` });
    const migrationDirectory = resolve(import.meta.dirname, "../../migrations");
    for (const file of readdirSync(migrationDirectory).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort()) {
      await pool.query(readFileSync(resolve(migrationDirectory, file), "utf8"));
    }
    await pool.query(
      `
        INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES
          ('user-admin', 'Admin', 'admin@example.com', TRUE, NOW(), NOW()),
          ('user-one', 'Member One', 'one@example.com', TRUE, NOW(), NOW()),
          ('user-two', 'Member Two', 'two@example.com', TRUE, NOW(), NOW());
        INSERT INTO organization (id, name, slug, "createdAt")
          VALUES ('organization-usage', 'Acme', 'usage-acme', NOW());
        INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES
          ('member-admin', 'organization-usage', 'user-admin', 'admin', NOW()),
          ('member-one', 'organization-usage', 'user-one', 'member', NOW()),
          ('member-two', 'organization-usage', 'user-two', 'member', NOW());
        INSERT INTO organization_policies (organization_id, usage_analytics_epoch, usage_analytics_started_at)
          VALUES ('organization-usage', '${epoch}', '2026-08-01T00:00:00Z');
        INSERT INTO devices (id, organization_id, user_id, name, platform, app_version, created_at, updated_at) VALUES
          ('10000000-0000-4000-8000-000000000001', 'organization-usage', 'user-one', 'One Mac', 'macos', '1.5.4', '2026-08-01T00:00:00Z', NOW()),
          ('10000000-0000-4000-8000-000000000002', 'organization-usage', 'user-two', 'Two Mac', 'macos', '1.5.4', '2026-08-01T00:00:00Z', NOW());
      `,
    );
    const enrollment = {
      authenticatedDevice: async () => ({
        deviceId: activeMember === "member-one"
          ? "10000000-0000-4000-8000-000000000001"
          : "10000000-0000-4000-8000-000000000002",
        memberId: activeMember,
        organizationId,
        userId: activeMember === "member-one" ? "user-one" : "user-two",
      }),
    } as unknown as EnrollmentService;
    const viewer = {
      organization: { id: organizationId, name: "Acme" },
      role: "admin" as const,
      usageAnalytics: { canManage: true, canView: true },
      user: { email: "admin@example.com", id: "user-admin", name: "Admin" },
    };
    const identity = {
      getViewer: async () => viewer,
      requireAdmin: async () => viewer,
      requireAdminForMutation: async () => viewer,
    } as unknown as IdentityService;
    service = new UsageAnalyticsService(pool, identity, enrollment);
  });

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminPool.end();
    }
  });

  function batch(inputTokens: number, outputTokens: number) {
    return {
      epoch,
      sourceId,
      snapshots: [{
        agentId: "codex",
        appVersion: "1.5.4",
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        costCoveredTokens: inputTokens + outputTokens + 30,
        estimatedCostMicrousd: 500,
        inputTokens,
        model: "gpt-test",
        outputTokens,
        pricingVersion: "lori-test",
        totalTurns: 1,
        usageDate: "2026-08-11",
      }],
    };
  }

  it("uses collection-on, member-hidden, lifetime-retention migration defaults", async () => {
    const settings = await service.settings({});
    expect(settings).toMatchObject({
      collectionEnabled: true,
      memberVisibilityDefault: false,
      retentionDays: null,
      revision: 1,
    });
  });

  it("creates principals for every member and always shows administrator visibility", async () => {
    const ranking = await service.members({}, {
      agents: [],
      from: "2026-08-01",
      limit: 10,
      models: [],
      offset: 0,
      query: "",
      sort: "tokens",
      to: "2026-08-11",
    });
    expect(ranking.pageInfo.total).toBe(4);
    expect(ranking.members.find((member) => member.memberId === "member-admin")?.visibility).toBe("shown");
    expect(ranking.members.find((member) => member.memberId === "member-one")?.visibility).toBe("hidden");
    expect(ranking.members.find((member) => member.id === "former-members")?.visibility).toBe("former");
  });

  it("makes replays idempotent and ignores stale lower absolute counters", async () => {
    activeMember = "member-one";
    await service.ingest("Bearer device-one", batch(100, 20));
    await service.ingest("Bearer device-one", batch(100, 20));
    await service.ingest("Bearer device-one", batch(50, 30));
    const analytics = await service.adminAnalytics({}, undefined, {
      agents: [], from: "2026-08-01", models: [], to: "2026-08-11",
    });
    expect(analytics.totals).toMatchObject({
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 160,
      totalTurns: 1,
    });
  });

  it("rejects source rebinding and stale epochs", async () => {
    activeMember = "member-two";
    await expect(service.ingest("Bearer device-two", batch(1, 1))).rejects.toMatchObject({
      code: "usage_source_conflict",
      statusCode: 409,
    } satisfies Partial<IdentityError>);
    await expect(service.ingest("Bearer device-two", { ...batch(1, 1), epoch: randomUUID(), sourceId: randomUUID() })).rejects.toMatchObject({
      code: "usage_epoch_stale",
      statusCode: 409,
    } satisfies Partial<IdentityError>);
  });

  it("filters usage whose model metadata was not reported", async () => {
    activeMember = "member-one";
    const unknownSourceId = randomUUID();
    const unknownBatch = batch(7, 3);
    await service.ingest("Bearer device-one", {
      ...unknownBatch,
      sourceId: unknownSourceId,
      snapshots: [{ ...unknownBatch.snapshots[0]!, model: undefined }],
    });
    const analytics = await service.adminAnalytics({}, undefined, {
      agents: [], from: "2026-08-01", models: ["unknown"], to: "2026-08-11",
    });
    expect(analytics.totals.totalTokens).toBe(40);
    expect(analytics.models).toEqual([
      expect.objectContaining({ id: "unknown", label: "Model not reported" }),
    ]);
    await pool.query("DELETE FROM usage_analytics_sources WHERE id = $1", [unknownSourceId]);
  });

  it("enforces optimistic concurrency for member visibility overrides", async () => {
    const initial = await service.memberVisibility({}, "member-one");
    expect(initial).toMatchObject({ effective: false, override: "inherit", revision: 1 });
    const shown = await service.setMemberVisibility({}, "member-one", "show", initial.revision);
    expect(shown).toMatchObject({ effective: true, override: "show", revision: 2 });
    await expect(
      service.setMemberVisibility({}, "member-one", "hide", initial.revision),
    ).rejects.toMatchObject({ code: "revision_conflict", statusCode: 409 });
  });

  it("rotates collection epochs without deleting retained history", async () => {
    activeMember = "member-one";
    const memberEpoch = randomUUID();
    await pool.query(
      `
        INSERT INTO member_usage_analytics_state (
          member_id, organization_id, collection_epoch, collection_started_at
        ) VALUES ('member-one', $1, $2, '2026-08-05T00:00:00Z')
        ON CONFLICT (member_id) DO UPDATE SET
          collection_epoch = EXCLUDED.collection_epoch,
          collection_started_at = EXCLUDED.collection_started_at
      `,
      [organizationId, memberEpoch],
    );
    const before = await service.settings({});
    const disabled = await service.updateSettings({}, {
      collectionEnabled: false,
      expectedRevision: before.revision,
      memberVisibilityDefault: true,
      retentionDays: null,
    });
    expect(disabled).toMatchObject({
      collectionEnabled: false,
      memberVisibilityDefault: true,
      retentionDays: null,
      revision: before.revision + 1,
    });
    const retained = await service.adminAnalytics({}, undefined, {
      agents: [], from: "2026-08-01", models: [], to: "2026-08-11",
    });
    expect(retained.totals.totalTokens).toBe(160);
    expect(retained.collectionEnabled).toBe(false);
    const reenabled = await service.updateSettings({}, {
      collectionEnabled: true,
      expectedRevision: disabled.revision,
      memberVisibilityDefault: true,
      retentionDays: null,
    });
    expect(reenabled.revision).toBe(disabled.revision + 1);
    const effectivePolicy = await service.desktopPolicy("Bearer device-one");
    expect(effectivePolicy.epoch).not.toBe(memberEpoch);
    expect(Date.parse(effectivePolicy.startedAt)).toBeGreaterThanOrEqual(
      Date.parse(reenabled.collectionStartedAt),
    );
    await expect(service.ingest("Bearer device-one", {
      ...batch(1, 1),
      epoch: memberEpoch,
      sourceId: randomUUID(),
    })).rejects.toMatchObject({
      code: "usage_epoch_stale",
      statusCode: 409,
    });
    await expect(service.ingest("Bearer device-one", batch(1, 1))).rejects.toMatchObject({
      code: "usage_epoch_stale",
      statusCode: 409,
    });
  });

  it("keeps member ranking bounded and uses the principal/date path at 2,500 members", async () => {
    await pool.query(
      `
        INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        SELECT
          'scale-user-' || member_number,
          'Scale Member ' || member_number,
          'scale-' || member_number || '@example.com',
          TRUE,
          NOW(),
          NOW()
        FROM generate_series(1, 2500) member_number;

        INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
        SELECT
          'scale-member-' || member_number,
          '${organizationId}',
          'scale-user-' || member_number,
          'member',
          NOW()
        FROM generate_series(1, 2500) member_number;

        INSERT INTO usage_analytics_sources (
          id, organization_id, principal_id, collection_epoch, app_version
        )
        SELECT
          ('30000000-0000-4000-8000-' || lpad(member_number::text, 12, '0'))::uuid,
          '${organizationId}',
          principals.id,
          '${epoch}',
          '1.5.4'
        FROM generate_series(1, 2500) member_number
        JOIN usage_analytics_principals principals
          ON principals.organization_id = '${organizationId}'
         AND principals.member_id = 'scale-member-' || member_number;

        INSERT INTO usage_analytics_daily (
          usage_date, organization_id, source_id, agent_id, model, total_turns,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          estimated_cost_microusd, cost_covered_tokens, app_version, pricing_version
        )
        SELECT
          '2026-08-11'::date,
          '${organizationId}',
          ('30000000-0000-4000-8000-' || lpad(member_number::text, 12, '0'))::uuid,
          'codex',
          'gpt-scale',
          member_number,
          member_number * 100,
          member_number * 20,
          0,
          0,
          member_number * 5,
          member_number * 120,
          '1.5.4',
          'scale-test'
        FROM generate_series(1, 2500) member_number;

        ANALYZE usage_analytics_principals;
        ANALYZE usage_analytics_sources;
        ANALYZE usage_analytics_daily;
      `,
    );

    const ranking = await service.members({}, {
      agents: [],
      from: "2026-08-01",
      limit: 50,
      models: [],
      offset: 0,
      query: "",
      sort: "tokens",
      to: "2026-08-11",
    });
    expect(ranking.members).toHaveLength(50);
    expect(ranking.pageInfo).toEqual({ hasMore: true, limit: 50, offset: 0, total: 2504 });
    expect(Buffer.byteLength(JSON.stringify(ranking), "utf8")).toBeLessThan(32_000);

    const principal = await pool.query<{ id: string }>(
      `SELECT id::text FROM usage_analytics_principals WHERE organization_id = $1 AND member_id = 'scale-member-2500'`,
      [organizationId],
    );
    const principalId = principal.rows[0]!.id;
    const plan = await pool.query<{ "QUERY PLAN": unknown }>(
      `
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT SUM(daily.input_tokens + daily.output_tokens)
        FROM usage_analytics_sources sources
        JOIN usage_analytics_daily daily
          ON daily.organization_id = sources.organization_id
         AND daily.source_id = sources.id
        WHERE sources.organization_id = $1
          AND sources.principal_id = $2::uuid
          AND daily.usage_date BETWEEN '2026-08-01'::date AND '2026-08-11'::date
      `,
      [organizationId, principalId],
    );
    expect(JSON.stringify(plan.rows[0]?.["QUERY PLAN"])).toContain("usage_sources_principal_idx");
  });

  it("retains exactly the configured number of UTC dates", async () => {
    const source = randomUUID();
    const dates = await pool.query<{ expired: string; retained: string; today: string }>(
      `
        SELECT
          to_char(CURRENT_DATE - 30, 'YYYY-MM-DD') AS expired,
          to_char(CURRENT_DATE - 29, 'YYYY-MM-DD') AS retained,
          to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today
      `,
    );
    const { expired, retained, today } = dates.rows[0]!;
    await pool.query("SELECT ensure_usage_analytics_partition($1::date)", [expired]);
    await pool.query("SELECT ensure_usage_analytics_partition($1::date)", [retained]);
    await pool.query(
      `
        INSERT INTO usage_analytics_sources (
          id, organization_id, principal_id, collection_epoch, app_version
        )
        SELECT $1, $2, principals.id, policies.usage_analytics_epoch, '1.5.4'
        FROM usage_analytics_principals principals
        JOIN organization_policies policies ON policies.organization_id = principals.organization_id
        WHERE principals.organization_id = $2 AND principals.member_id = 'member-one'
      `,
      [source, organizationId],
    );
    await pool.query(
      `
        INSERT INTO usage_analytics_daily (
          usage_date, organization_id, source_id, agent_id, model, total_turns,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          estimated_cost_microusd, cost_covered_tokens, app_version, pricing_version
        ) VALUES
          ($1, $3, $4, 'codex', 'retention-test', 1, 100, 0, 0, 0, 10, 100, '1.5.4', 'test'),
          ($2, $3, $4, 'codex', 'retention-test', 1, 200, 0, 0, 0, 20, 200, '1.5.4', 'test')
      `,
      [expired, retained, organizationId, source],
    );
    await pool.query(
      "UPDATE organization_policies SET usage_retention_days = 30 WHERE organization_id = $1",
      [organizationId],
    );

    const analytics = await service.adminAnalytics({}, undefined, {
      agents: [],
      from: "2000-01-01",
      models: ["retention-test"],
      to: today,
    });
    expect(analytics.totals.totalTokens).toBe(200);

    await service.cleanupExpired();
    const remaining = await pool.query<{ usage_date: string }>(
      `SELECT to_char(usage_date, 'YYYY-MM-DD') AS usage_date FROM usage_analytics_daily WHERE source_id = $1 ORDER BY usage_date`,
      [source],
    );
    expect(remaining.rows).toEqual([{ usage_date: retained }]);
    await pool.query("DELETE FROM usage_analytics_sources WHERE id = $1", [source]);
    await pool.query(
      "UPDATE organization_policies SET usage_retention_days = NULL WHERE organization_id = $1",
      [organizationId],
    );
  });
});
