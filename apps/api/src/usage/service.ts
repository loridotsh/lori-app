import {
  captureCloudUsageAdmission,
  recordCloudUsageRound,
  type CloudUsageContext,
} from "../cloud/usage.js";
import type { CloudReportedUsage, Role } from "@lori-enterprise/contracts";
import { isOrganizationAdministrator } from "@lori-enterprise/contracts";
import type { WorkService } from "../auth/work-service.js";
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Pool, PoolClient } from "pg";
import type {
  DesktopUsageAnalyticsPolicy,
  DesktopUsageIngestResponse,
  DesktopUsageSnapshotBatch,
  MemberUsageVisibility,
  UsageAnalyticsBreakdown,
  UsageAnalyticsGranularity,
  UsageAnalyticsMemberRow,
  UsageAnalyticsMembersResponse,
  UsageAnalyticsResponse,
  UsageAnalyticsRetentionDays,
  UsageAnalyticsSettings,
  UsageMemberVisibilityOverride,
  Viewer,
} from "@lori-enterprise/contracts";
import type { EnrollmentService } from "../auth/enrollment-service.js";
import { recordAuditEvent } from "../auth/audit.js";
import {
  IdentityError,
  type IdentityService,
} from "../auth/identity-service.js";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const RETENTION_LOCK = 1_912_024_101;

interface RangeOptions {
  agents: string[];
  from: string;
  models: string[];
  to: string;
  product?: "code" | "work";
}

interface MemberContext {
  memberId: string;
  organizationId: string;
  viewer: Viewer;
}

interface PolicyRow {
  usage_analytics_enabled: boolean;
  usage_analytics_epoch: string;
  usage_analytics_started_at: Date;
  usage_member_visibility_default: boolean;
  usage_retention_days: number | null;
  usage_settings_revision: string;
  usage_settings_updated_at: Date;
  updated_by_name: string | null;
}

interface AggregateRow {
  active_members: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  cost_covered_tokens: string;
  estimated_cost_microusd: string;
  input_tokens: string;
  last_received_at: Date | null;
  output_tokens: string;
  total_turns: string;
}

function safeInteger(
  value: string | number | null | undefined,
  field: string,
): number {
  const parsed = BigInt(value ?? 0);
  if (parsed < 0n || parsed > MAX_SAFE_BIGINT) {
    throw new IdentityError(
      503,
      "usage_value_out_of_range",
      `The ${field} aggregate is outside the supported range.`,
    );
  }
  return Number(parsed);
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function granularity(from: string, to: string): UsageAnalyticsGranularity {
  const days = Math.floor(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
  return days < 90 ? "day" : days < 730 ? "week" : "month";
}

function previousRange(from: string, to: string): { from: string; to: string } {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const duration = end - start + 86_400_000;
  const previousTo = new Date(start - 86_400_000);
  return {
    from: new Date(previousTo.getTime() - duration + 86_400_000)
      .toISOString()
      .slice(0, 10),
    to: previousTo.toISOString().slice(0, 10),
  };
}

function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function visibilityOverride(
  value: boolean | null,
): UsageMemberVisibilityOverride {
  return value === null ? "inherit" : value ? "show" : "hide";
}

export class UsageAnalyticsService {
  private retentionTimer?: NodeJS.Timeout;

  public constructor(
    private readonly pool: Pool,
    private readonly identity: IdentityService,
    private readonly enrollment: EnrollmentService,
    private readonly work?: WorkService,
  ) {}

  /** Trusted API admissions only; no device identity or client-selected source. */
  public captureCloudAdmission(
    c: PoolClient,
    organizationId: string,
    memberId: string,
  ) {
    return captureCloudUsageAdmission(c, organizationId, memberId);
  }
  public recordCloudRound(
    c: PoolClient,
    context: CloudUsageContext,
    sequence: number,
    usage: CloudReportedUsage,
  ) {
    return recordCloudUsageRound(c, context, sequence, usage);
  }

  private async memberContext(
    headers: IncomingHttpHeaders,
  ): Promise<MemberContext> {
    const viewer = await this.identity.getViewer(headers);
    const result = await this.pool.query<{ member_id: string }>(
      `
        SELECT id AS member_id
        FROM member
        WHERE "organizationId" = $1 AND "userId" = $2
        LIMIT 1
      `,
      [viewer.organization.id, viewer.user.id],
    );
    const memberId = result.rows[0]?.member_id;
    if (!memberId) {
      throw new IdentityError(
        403,
        "membership_required",
        "Organization membership is required.",
      );
    }
    return { memberId, organizationId: viewer.organization.id, viewer };
  }

  private async policy(
    organizationId: string,
    database: Pool | PoolClient = this.pool,
    lock = false,
  ): Promise<PolicyRow> {
    const result = await database.query<PolicyRow>(
      `
        SELECT
          policies.usage_analytics_enabled,
          policies.usage_analytics_epoch::text,
          policies.usage_analytics_started_at,
          policies.usage_member_visibility_default,
          policies.usage_retention_days,
          policies.usage_settings_revision::text,
          policies.usage_settings_updated_at,
          updater.name AS updated_by_name
        FROM organization_policies policies
        LEFT JOIN "user" updater ON updater.id = policies.usage_settings_updated_by_user_id
        WHERE policies.organization_id = $1
        ${lock ? "FOR UPDATE OF policies" : ""}
      `,
      [organizationId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new IdentityError(
        503,
        "usage_policy_unavailable",
        "Usage analytics policy is unavailable.",
      );
    }
    return row;
  }

  public async desktopPolicy(
    authorization: string | undefined,
  ): Promise<DesktopUsageAnalyticsPolicy> {
    const device = await this.enrollment.authenticatedDevice(authorization);
    const result = await this.pool.query<{
      enabled: boolean;
      epoch: string;
      started_at: Date;
    }>(
      `
        SELECT
          policies.usage_analytics_enabled AS enabled,
          CASE
            WHEN member_state.collection_started_at > policies.usage_analytics_started_at
              THEN member_state.collection_epoch
            ELSE policies.usage_analytics_epoch
          END::text AS epoch,
          GREATEST(
            policies.usage_analytics_started_at,
            COALESCE(member_state.collection_started_at, policies.usage_analytics_started_at),
            devices.created_at
          ) AS started_at
        FROM organization_policies policies
        JOIN devices
          ON devices.id = $3
         AND devices.organization_id = policies.organization_id
         AND devices.user_id = $4
        LEFT JOIN member_usage_analytics_state member_state
          ON member_state.organization_id = policies.organization_id
         AND member_state.member_id = $2
        WHERE policies.organization_id = $1
      `,
      [device.organizationId, device.memberId, device.deviceId, device.userId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new IdentityError(
        503,
        "usage_policy_unavailable",
        "Usage analytics policy is unavailable.",
      );
    }
    return {
      enabled: row.enabled,
      epoch: row.epoch,
      startedAt: row.started_at.toISOString(),
    };
  }

  public async ingest(
    authorization: string | undefined,
    batch: DesktopUsageSnapshotBatch & { enrolledAt?: string },
    product: "code" | "work" = "code",
  ): Promise<DesktopUsageIngestResponse> {
    const device = await this.enrollment.authenticatedDevice(authorization);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const state = await client.query<{
        enabled: boolean;
        epoch: string;
        started_at: Date;
      }>(
        `
          SELECT
            policies.usage_analytics_enabled AS enabled,
            CASE
              WHEN member_state.collection_started_at > policies.usage_analytics_started_at
                THEN member_state.collection_epoch
              ELSE policies.usage_analytics_epoch
            END::text AS epoch,
            GREATEST(
              policies.usage_analytics_started_at,
              COALESCE(member_state.collection_started_at, policies.usage_analytics_started_at),
              devices.created_at
            ) AS started_at
          FROM organization_policies policies
          JOIN devices
            ON devices.id = $3
           AND devices.organization_id = policies.organization_id
           AND devices.user_id = $4
           AND devices.revoked_at IS NULL
          ${product === "work" ? "JOIN device_sessions sessions ON sessions.device_id=devices.id AND sessions.id=$5 AND sessions.revoked_at IS NULL AND sessions.access_expires_at > NOW()" : ""}
          LEFT JOIN member_usage_analytics_state member_state
            ON member_state.organization_id = policies.organization_id
           AND member_state.member_id = $2
          WHERE policies.organization_id = $1
          FOR SHARE OF policies, devices${product === "work" ? ", sessions" : ""}
        `,
        [
          device.organizationId,
          device.memberId,
          device.deviceId,
          device.userId,
          ...(product === "work" ? [device.sessionId] : []),
        ],
      );
      const policy = state.rows[0];
      if (product === "work" && !policy)
        throw new IdentityError(
          401,
          "device_session_expired",
          "The device session is expired or revoked.",
        );
      if (!policy?.enabled) {
        throw new IdentityError(
          409,
          "usage_collection_disabled",
          "Usage analytics collection is disabled.",
        );
      }
      if (policy.epoch !== batch.epoch) {
        throw new IdentityError(
          409,
          "usage_epoch_stale",
          "Refresh Enterprise policy before uploading usage.",
        );
      }

      if (product === "work") {
        if (!this.work)
          throw new IdentityError(
            503,
            "work_policy_unavailable",
            "Work policy is unavailable.",
          );
        // Reporting a previously admitted request remains valid after Work is
        // disabled; otherwise the cancellation's final counters disappear.
        // The shared policy lock above still verifies a provisioned authority.
        await this.work.effectiveForMember(
          device.organizationId,
          device.memberId,
          client,
        );
        const enrolledAt = Date.parse(batch.enrolledAt ?? "");
        if (
          !Number.isFinite(enrolledAt) ||
          enrolledAt < policy.started_at.getTime() ||
          enrolledAt > Date.now() + 60_000
        )
          throw new IdentityError(
            400,
            "work_usage_enrollment_invalid",
            "Work usage requires a current enrollment collection window.",
          );
      }
      const principal = await client.query<{ id: string }>(
        `
          INSERT INTO usage_analytics_principals (
            id, organization_id, member_id, user_id, display_name, email
          )
          SELECT gen_random_uuid(), $1, members.id, users.id, users.name, users.email
          FROM member members
          JOIN "user" users ON users.id = members."userId"
          WHERE members.id = $2
            AND members."organizationId" = $1
            AND users.id = $3
          ON CONFLICT (organization_id, member_id) WHERE member_id IS NOT NULL
          DO UPDATE SET
            user_id = EXCLUDED.user_id,
            display_name = EXCLUDED.display_name,
            email = EXCLUDED.email
          RETURNING id::text
        `,
        [device.organizationId, device.memberId, device.userId],
      );
      const principalId = principal.rows[0]?.id;
      if (!principalId) {
        throw new IdentityError(
          403,
          "membership_required",
          "Organization membership is required.",
        );
      }

      const existingSource = await client.query<{
        collection_epoch: string;
        organization_id: string;
        principal_id: string;
        product: string;
        enrolled_at: Date | null;
        work_device_id: string | null;
        delivery_location: string;
      }>(
        `
          SELECT organization_id, principal_id::text, collection_epoch::text, product, enrolled_at, work_device_id::text,delivery_location
          FROM usage_analytics_sources
          WHERE id = $1
          FOR UPDATE
        `,
        [batch.sourceId],
      );
      const source = existingSource.rows[0];
      if (
        source &&
        (source.organization_id !== device.organizationId ||
          source.principal_id !== principalId ||
          source.collection_epoch !== batch.epoch ||
          source.product !== product ||
          source.delivery_location !== "desktop" ||
          (product === "work" &&
            (source.work_device_id !== device.deviceId ||
              source.enrolled_at?.toISOString() !==
                new Date(batch.enrolledAt!).toISOString())))
      ) {
        throw new IdentityError(
          409,
          "usage_source_conflict",
          "The usage source is already bound to another identity.",
        );
      }
      const appVersion = batch.snapshots[0]?.appVersion ?? "unknown";
      if (!source) {
        await client.query(
          `
            INSERT INTO usage_analytics_sources (
              id, organization_id, principal_id, collection_epoch, last_device_id, app_version, product, enrolled_at, work_device_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            batch.sourceId,
            device.organizationId,
            principalId,
            batch.epoch,
            device.deviceId,
            appVersion,
            product,
            batch.enrolledAt ?? null,
            product === "work" ? device.deviceId : null,
          ],
        );
      }

      const earliest = dateOnly(
        product === "work" ? new Date(batch.enrolledAt!) : policy.started_at,
      );
      const latest = dateOnly(new Date());
      for (const snapshot of batch.snapshots) {
        if (snapshot.usageDate < earliest || snapshot.usageDate > latest) {
          throw new IdentityError(
            400,
            "usage_date_out_of_range",
            "A usage date is outside the eligible collection window.",
          );
        }
        await client.query(
          "SELECT ensure_usage_analytics_partition($1::date)",
          [snapshot.usageDate],
        );
        await client.query(
          `
            INSERT INTO usage_analytics_daily (
              usage_date, organization_id, source_id, agent_id, model,
              total_turns, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, estimated_cost_microusd, cost_covered_tokens,
              app_version, pricing_version
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
            )
            ON CONFLICT (usage_date, organization_id, source_id, agent_id, model)
            DO UPDATE SET
              total_turns = GREATEST(usage_analytics_daily.total_turns, EXCLUDED.total_turns),
              input_tokens = GREATEST(usage_analytics_daily.input_tokens, EXCLUDED.input_tokens),
              output_tokens = GREATEST(usage_analytics_daily.output_tokens, EXCLUDED.output_tokens),
              cache_read_tokens = GREATEST(usage_analytics_daily.cache_read_tokens, EXCLUDED.cache_read_tokens),
              cache_write_tokens = GREATEST(usage_analytics_daily.cache_write_tokens, EXCLUDED.cache_write_tokens),
              estimated_cost_microusd = GREATEST(usage_analytics_daily.estimated_cost_microusd, EXCLUDED.estimated_cost_microusd),
              cost_covered_tokens = GREATEST(usage_analytics_daily.cost_covered_tokens, EXCLUDED.cost_covered_tokens),
              app_version = EXCLUDED.app_version,
              pricing_version = EXCLUDED.pricing_version,
              last_received_at = NOW()
          `,
          [
            snapshot.usageDate,
            device.organizationId,
            batch.sourceId,
            snapshot.agentId,
            snapshot.model ?? "",
            snapshot.totalTurns,
            snapshot.inputTokens,
            snapshot.outputTokens,
            snapshot.cacheReadTokens,
            snapshot.cacheWriteTokens,
            snapshot.estimatedCostMicrousd,
            snapshot.costCoveredTokens,
            snapshot.appVersion,
            snapshot.pricingVersion,
          ],
        );
      }
      await client.query(
        `
          UPDATE usage_analytics_sources
          SET last_received_at = NOW(), last_device_id = $2, app_version = $3
          WHERE id = $1 AND organization_id = $4
        `,
        [batch.sourceId, device.deviceId, appVersion, device.organizationId],
      );
      await client.query("COMMIT");
      return {
        accepted: batch.snapshots.length,
        receivedAt: new Date().toISOString(),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private filters(
    options: RangeOptions,
    startIndex = 4,
  ): { sql: string; values: unknown[] } {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (options.agents.length) {
      values.push(options.agents);
      clauses.push(
        `daily.agent_id = ANY($${startIndex + values.length - 1}::text[])`,
      );
    }
    if (options.models.length) {
      values.push(
        options.models.map((model) => (model === "unknown" ? "" : model)),
      );
      clauses.push(
        `daily.model = ANY($${startIndex + values.length - 1}::text[])`,
      );
    }
    return {
      sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "",
      values,
    };
  }

  private async analyticsFor(
    organizationId: string,
    scope: { memberId?: string; name: string; type: "organization" | "member" },
    options: RangeOptions,
  ): Promise<UsageAnalyticsResponse> {
    const policy = await this.policy(organizationId);
    const effectiveFrom = policy.usage_retention_days
      ? `GREATEST($2::date, CURRENT_DATE - (${policy.usage_retention_days} - 1))`
      : "$2::date";
    const memberClause = scope.memberId ? " AND principals.member_id = $4" : "";
    const baseValues: unknown[] = [organizationId, options.from, options.to];
    if (scope.memberId) baseValues.push(scope.memberId);
    const filterStart = baseValues.length + 1;
    const filter = this.filters(options, filterStart);
    const values = [...baseValues, ...filter.values];
    const common = `
      FROM usage_analytics_daily daily
      JOIN usage_analytics_sources sources
        ON sources.id = daily.source_id AND sources.organization_id = daily.organization_id
      JOIN usage_analytics_principals principals
        ON principals.id = sources.principal_id AND principals.organization_id = sources.organization_id
      WHERE daily.organization_id = $1
        AND sources.product = '${options.product === "work" ? "work" : "code"}'
        AND daily.usage_date BETWEEN ${effectiveFrom} AND $3::date
        ${memberClause}${filter.sql}
    `;
    const totalsResult = await this.pool.query<AggregateRow>(
      `
        SELECT
          COUNT(DISTINCT principals.id) FILTER (WHERE principals.anonymized = FALSE)::text AS active_members,
          COALESCE(SUM(daily.input_tokens), 0)::text AS input_tokens,
          COALESCE(SUM(daily.output_tokens), 0)::text AS output_tokens,
          COALESCE(SUM(daily.cache_read_tokens), 0)::text AS cache_read_tokens,
          COALESCE(SUM(daily.cache_write_tokens), 0)::text AS cache_write_tokens,
          COALESCE(SUM(daily.total_turns), 0)::text AS total_turns,
          COALESCE(SUM(daily.estimated_cost_microusd), 0)::text AS estimated_cost_microusd,
          COALESCE(SUM(daily.cost_covered_tokens), 0)::text AS cost_covered_tokens,
          MAX(daily.last_received_at) AS last_received_at
        ${common}
      `,
      values,
    );
    const priorRange = previousRange(options.from, options.to);
    const priorValues = [...values];
    priorValues[1] = priorRange.from;
    priorValues[2] = priorRange.to;
    const priorTotalsResult = await this.pool.query<AggregateRow>(
      `
        SELECT
          COUNT(DISTINCT principals.id) FILTER (WHERE principals.anonymized = FALSE)::text AS active_members,
          COALESCE(SUM(daily.input_tokens), 0)::text AS input_tokens,
          COALESCE(SUM(daily.output_tokens), 0)::text AS output_tokens,
          COALESCE(SUM(daily.cache_read_tokens), 0)::text AS cache_read_tokens,
          COALESCE(SUM(daily.cache_write_tokens), 0)::text AS cache_write_tokens,
          COALESCE(SUM(daily.total_turns), 0)::text AS total_turns,
          COALESCE(SUM(daily.estimated_cost_microusd), 0)::text AS estimated_cost_microusd,
          COALESCE(SUM(daily.cost_covered_tokens), 0)::text AS cost_covered_tokens,
          MAX(daily.last_received_at) AS last_received_at
        ${common}
      `,
      priorValues,
    );
    const totalsRow = totalsResult.rows[0]!;
    const inputTokens = safeInteger(totalsRow.input_tokens, "input tokens");
    const outputTokens = safeInteger(totalsRow.output_tokens, "output tokens");
    const cacheReadTokens = safeInteger(
      totalsRow.cache_read_tokens,
      "cache read tokens",
    );
    const cacheWriteTokens = safeInteger(
      totalsRow.cache_write_tokens,
      "cache write tokens",
    );
    const totalTokens =
      inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    if (!Number.isSafeInteger(totalTokens)) {
      throw new IdentityError(
        503,
        "usage_value_out_of_range",
        "The total token aggregate is outside the supported range.",
      );
    }
    const costCoveredTokens = safeInteger(
      totalsRow.cost_covered_tokens,
      "cost-covered tokens",
    );
    const priorRow = priorTotalsResult.rows[0]!;
    const priorTokens =
      safeInteger(priorRow.input_tokens, "previous input tokens") +
      safeInteger(priorRow.output_tokens, "previous output tokens") +
      safeInteger(priorRow.cache_read_tokens, "previous cache read tokens") +
      safeInteger(priorRow.cache_write_tokens, "previous cache write tokens");
    const estimatedCostMicrousd = safeInteger(
      totalsRow.estimated_cost_microusd,
      "estimated cost",
    );
    const totalTurns = safeInteger(totalsRow.total_turns, "turns");
    const bucket = granularity(options.from, options.to);
    const dateExpression =
      bucket === "day"
        ? "daily.usage_date"
        : bucket === "week"
          ? "date_trunc('week', daily.usage_date)::date"
          : "date_trunc('month', daily.usage_date)::date";
    const series = await this.pool.query<{
      cache_read_tokens: string;
      cache_write_tokens: string;
      estimated_cost_microusd: string;
      input_tokens: string;
      label: string;
      output_tokens: string;
      total_turns: string;
    }>(
      `
        SELECT
          to_char(${dateExpression}, 'YYYY-MM-DD') AS label,
          SUM(daily.input_tokens)::text AS input_tokens,
          SUM(daily.output_tokens)::text AS output_tokens,
          SUM(daily.cache_read_tokens)::text AS cache_read_tokens,
          SUM(daily.cache_write_tokens)::text AS cache_write_tokens,
          SUM(daily.total_turns)::text AS total_turns,
          SUM(daily.estimated_cost_microusd)::text AS estimated_cost_microusd
        ${common}
        GROUP BY ${dateExpression}
        ORDER BY ${dateExpression}
      `,
      values,
    );
    const breakdown = async (
      column: "agent_id" | "model",
    ): Promise<UsageAnalyticsBreakdown[]> => {
      const result = await this.pool.query<{
        estimated_cost_microusd: string;
        cost_covered_tokens: string;
        id: string;
        total_tokens: string;
        total_turns: string;
      }>(
        `
          SELECT
            daily.${column} AS id,
            SUM(daily.input_tokens + daily.output_tokens + daily.cache_read_tokens + daily.cache_write_tokens)::text AS total_tokens,
            SUM(daily.total_turns)::text AS total_turns,
            SUM(daily.estimated_cost_microusd)::text AS estimated_cost_microusd,
            SUM(daily.cost_covered_tokens)::text AS cost_covered_tokens
          ${common}
          GROUP BY daily.${column}
          ORDER BY SUM(daily.input_tokens + daily.output_tokens + daily.cache_read_tokens + daily.cache_write_tokens) DESC, daily.${column}
          LIMIT 50
        `,
        values,
      );
      return result.rows.map((row) => ({
        ...(options.product === "work" ? { costCoveragePercent: Number(row.total_tokens) > 0 ? Math.min(100, safeInteger(row.cost_covered_tokens, "row priced tokens") / safeInteger(row.total_tokens, "row tokens") * 100) : 0 } : {}),
        estimatedCostMicrousd: safeInteger(
          row.estimated_cost_microusd,
          "estimated cost",
        ),
        id: row.id || "unknown",
        label:
          row.id ||
          (column === "model" ? "Model not reported" : "Agent not reported"),
        totalTokens: safeInteger(row.total_tokens, "breakdown tokens"),
        totalTurns: safeInteger(row.total_turns, "breakdown turns"),
      }));
    };
    const [agents, models] = await Promise.all([
      breakdown("agent_id"),
      breakdown("model"),
    ]);
    const lastReceivedAt = totalsRow.last_received_at?.toISOString();
    let cloudCoverage: UsageAnalyticsResponse["reporting"] | undefined;
    if (options.product === "work") {
      const coverage = (
        await this.pool.query<{
          rounds: string;
          input_known: string;
          output_known: string;
          read_known: string;
          write_known: string;
          unpriced: string;
        }>(
          `SELECT count(*)::text AS rounds,count(cloud.input_tokens)::text AS input_known,count(cloud.output_tokens)::text AS output_known,count(cloud.cache_read_tokens)::text AS read_known,count(cloud.cache_write_tokens)::text AS write_known,count(*) FILTER (WHERE COALESCE(cloud.usage->>'estimatedCostMicrousd',cloud.usage->>'costMicrousd') IS NULL)::text AS unpriced FROM cloud_usage_rounds cloud JOIN usage_analytics_sources sources ON sources.id=cloud.source_id AND sources.organization_id=cloud.organization_id JOIN usage_analytics_principals principals ON principals.id=sources.principal_id AND principals.organization_id=sources.organization_id WHERE cloud.organization_id=$1 AND sources.product='work' AND cloud.usage_date BETWEEN ${effectiveFrom} AND $3::date ${memberClause}${filter.sql.replaceAll("daily.", "cloud.")}`,
          [...values],
        )
      ).rows[0]!;
      if (Number(coverage.rounds) > 0)
        cloudCoverage = {
          cloud: {
            rounds: safeInteger(coverage.rounds, "reported rounds"),
            inputKnownRounds: safeInteger(
              coverage.input_known,
              "known input rounds",
            ),
            outputKnownRounds: safeInteger(
              coverage.output_known,
              "known output rounds",
            ),
            cacheReadKnownRounds: safeInteger(
              coverage.read_known,
              "known cache read rounds",
            ),
            cacheWriteKnownRounds: safeInteger(
              coverage.write_known,
              "known cache write rounds",
            ),
            unpricedRounds: safeInteger(coverage.unpriced, "unpriced rounds"),
          },
        };
    }
    return {
      ...(cloudCoverage ? { reporting: cloudCoverage } : {}),
      agents,
      collectionEnabled: policy.usage_analytics_enabled,
      comparison: {
        estimatedCostPercent: percentChange(
          estimatedCostMicrousd,
          safeInteger(
            priorRow.estimated_cost_microusd,
            "previous estimated cost",
          ),
        ),
        totalTokensPercent: percentChange(totalTokens, priorTokens),
        totalTurnsPercent: percentChange(
          totalTurns,
          safeInteger(priorRow.total_turns, "previous turns"),
        ),
      },
      freshness: {
        ...(lastReceivedAt ? { lastReceivedAt } : {}),
        stale: Boolean(
          lastReceivedAt &&
            Date.now() - Date.parse(lastReceivedAt) > 48 * 60 * 60 * 1_000,
        ),
      },
      models,
      range: { from: options.from, granularity: bucket, to: options.to },
      scope,
      series: series.rows.map((row) => {
        const input = safeInteger(row.input_tokens, "series input tokens");
        const output = safeInteger(row.output_tokens, "series output tokens");
        const cacheRead = safeInteger(
          row.cache_read_tokens,
          "series cache read tokens",
        );
        const cacheWrite = safeInteger(
          row.cache_write_tokens,
          "series cache write tokens",
        );
        return {
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          estimatedCostMicrousd: safeInteger(
            row.estimated_cost_microusd,
            "series estimated cost",
          ),
          inputTokens: input,
          label: row.label,
          outputTokens: output,
          totalTokens: input + output + cacheRead + cacheWrite,
          totalTurns: safeInteger(row.total_turns, "series turns"),
        };
      }),
      totals: {
        activeMembers: safeInteger(totalsRow.active_members, "active members"),
        cacheReadTokens,
        cacheWriteTokens,
        costCoveragePercent:
          totalTokens === 0
            ? cloudCoverage?.cloud.unpricedRounds
              ? 0
              : 100
            : Math.min(
                100,
                Math.round((costCoveredTokens / totalTokens) * 10_000) / 100,
              ),
        estimatedCostMicrousd,
        inputTokens,
        outputTokens,
        totalTokens,
        totalTurns,
      },
    };
  }

  public async ownAnalytics(
    headers: IncomingHttpHeaders,
    options: RangeOptions,
  ): Promise<UsageAnalyticsResponse> {
    const context = await this.memberContext(headers);
    if (!context.viewer.usageAnalytics?.canView) {
      throw new IdentityError(
        403,
        "usage_visibility_disabled",
        "Your organization has not enabled your usage view.",
      );
    }
    return this.analyticsFor(
      context.organizationId,
      {
        memberId: context.memberId,
        name: context.viewer.user.name,
        type: "member",
      },
      options,
    );
  }

  public async adminAnalytics(
    headers: IncomingHttpHeaders,
    memberId: string | undefined,
    options: RangeOptions,
  ): Promise<UsageAnalyticsResponse> {
    const viewer = await this.identity.requireAdmin(headers);
    if (!memberId) {
      return this.analyticsFor(
        viewer.organization.id,
        {
          name: viewer.organization.name,
          type: "organization",
        },
        options,
      );
    }
    const member = await this.pool.query<{ name: string }>(
      `
        SELECT users.name
        FROM member members
        JOIN "user" users ON users.id = members."userId"
        WHERE members.id = $1 AND members."organizationId" = $2
      `,
      [memberId, viewer.organization.id],
    );
    if (!member.rows[0])
      throw new IdentityError(404, "member_not_found", "Member not found.");
    return this.analyticsFor(
      viewer.organization.id,
      {
        memberId,
        name: member.rows[0].name,
        type: "member",
      },
      options,
    );
  }

  public analyticsCsv(analytics: UsageAnalyticsResponse): string {
    const rows = analytics.series.map((point) =>
      [
        point.label,
        analytics.range.granularity,
        point.totalTokens,
        point.inputTokens,
        point.outputTokens,
        point.cacheReadTokens,
        point.cacheWriteTokens,
        point.totalTurns,
        point.estimatedCostMicrousd,
        analytics.totals.costCoveragePercent,
      ]
        .map(csvCell)
        .join(","),
    );
    const breakdownRows = [
      ...analytics.agents.map((item) => [
        "Agent",
        item.label,
        item.totalTokens,
        item.totalTurns,
        item.estimatedCostMicrousd,
      ]),
      ...analytics.models.map((item) => [
        "Model",
        item.label,
        item.totalTokens,
        item.totalTurns,
        item.estimatedCostMicrousd,
      ]),
    ].map((row) => row.map(csvCell).join(","));
    return [
      "Period,Granularity,Total tokens,Input tokens,Output tokens,Cache read tokens,Cache write tokens,Turns,Estimated cost micro-USD,Cost coverage percent",
      ...rows,
      "",
      "Dimension,Label,Total tokens,Turns,Estimated cost micro-USD",
      ...breakdownRows,
    ].join("\n");
  }

  public async settings(
    headers: IncomingHttpHeaders,
  ): Promise<UsageAnalyticsSettings> {
    const viewer = await this.identity.requireAdmin(headers);
    const policy = await this.policy(viewer.organization.id);
    return {
      collectionEnabled: policy.usage_analytics_enabled,
      collectionStartedAt: policy.usage_analytics_started_at.toISOString(),
      memberVisibilityDefault: policy.usage_member_visibility_default,
      retentionDays: policy.usage_retention_days as UsageAnalyticsRetentionDays,
      revision: safeInteger(
        policy.usage_settings_revision,
        "settings revision",
      ),
      updatedAt: policy.usage_settings_updated_at.toISOString(),
      ...(policy.updated_by_name
        ? { updatedByName: policy.updated_by_name }
        : {}),
    };
  }

  public async updateSettings(
    headers: IncomingHttpHeaders,
    input: {
      collectionEnabled: boolean;
      expectedRevision: number;
      memberVisibilityDefault: boolean;
      retentionDays: UsageAnalyticsRetentionDays;
    },
  ): Promise<UsageAnalyticsSettings> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const viewer = await this.identity.requireAdminForMutation(
        headers,
        client,
      );
      const current = await this.policy(viewer.organization.id, client, true);
      if (
        safeInteger(current.usage_settings_revision, "settings revision") !==
        input.expectedRevision
      ) {
        throw new IdentityError(
          409,
          "revision_conflict",
          "Usage settings changed. Refresh and try again.",
        );
      }
      const collectionChanged =
        current.usage_analytics_enabled !== input.collectionEnabled;
      await client.query(
        `
          UPDATE organization_policies
          SET
            usage_analytics_enabled = $2,
            usage_member_visibility_default = $3,
            usage_retention_days = $4,
            usage_settings_revision = usage_settings_revision + 1,
            usage_settings_updated_at = NOW(),
            usage_settings_updated_by_user_id = $5,
            usage_analytics_epoch = CASE WHEN $6 THEN gen_random_uuid() ELSE usage_analytics_epoch END,
            usage_analytics_started_at = CASE WHEN $6 THEN NOW() ELSE usage_analytics_started_at END,
            revision = revision + CASE WHEN $6 THEN 1 ELSE 0 END,
            updated_at = NOW(),
            updated_by_user_id = $5
          WHERE organization_id = $1
        `,
        [
          viewer.organization.id,
          input.collectionEnabled,
          input.memberVisibilityDefault,
          input.retentionDays,
          viewer.user.id,
          collectionChanged,
        ],
      );
      await recordAuditEvent(client, {
        action: "usage.settings_updated",
        actorUserId: viewer.user.id,
        organizationId: viewer.organization.id,
        metadata: {
          collectionEnabled: input.collectionEnabled,
          collectionEpochRotated: collectionChanged,
          memberVisibilityDefault: input.memberVisibilityDefault,
          retentionDays: input.retentionDays,
        },
        subjectId: viewer.organization.id,
        subjectType: "organization",
      });
      await client.query("COMMIT");
      return this.settings(headers);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async memberVisibility(
    headers: IncomingHttpHeaders,
    memberId: string,
  ): Promise<MemberUsageVisibility> {
    const viewer = await this.identity.requireAdmin(headers);
    const result = await this.pool.query<{
      created_at: Date;
      email: string;
      member_id: string;
      name: string;
      role: Role;
      user_id: string;
      visibility_default: boolean;
      visibility_override: boolean | null;
      visibility_revision: string;
    }>(
      `
        SELECT
          members.id AS member_id, members.role, members."createdAt" AS created_at,
          users.id AS user_id, users.name, users.email,
          policies.usage_member_visibility_default AS visibility_default,
          member_state.visibility_override,
          COALESCE(member_state.revision, 1)::text AS visibility_revision
        FROM member members
        JOIN "user" users ON users.id = members."userId"
        JOIN organization_policies policies ON policies.organization_id = members."organizationId"
        LEFT JOIN member_usage_analytics_state member_state
          ON member_state.organization_id = members."organizationId"
         AND member_state.member_id = members.id
        WHERE members.id = $1 AND members."organizationId" = $2
      `,
      [memberId, viewer.organization.id],
    );
    const row = result.rows[0];
    if (!row)
      throw new IdentityError(404, "member_not_found", "Member not found.");
    return {
      effective:
        isOrganizationAdministrator(row.role) ||
        (row.visibility_override ?? row.visibility_default),
      member: {
        createdAt: row.created_at.toISOString(),
        email: row.email,
        memberId: row.member_id,
        name: row.name,
        role: row.role,
        userId: row.user_id,
      },
      override: visibilityOverride(row.visibility_override),
      revision: safeInteger(
        row.visibility_revision,
        "member visibility revision",
      ),
    };
  }

  public async setMemberVisibility(
    headers: IncomingHttpHeaders,
    memberId: string,
    override: UsageMemberVisibilityOverride,
    expectedRevision: number,
  ): Promise<MemberUsageVisibility> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const viewer = await this.identity.requireAdminForMutation(
        headers,
        client,
      );
      const member = await client.query<{ role: string }>(
        `SELECT role FROM member WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        [memberId, viewer.organization.id],
      );
      if (!member.rows[0])
        throw new IdentityError(404, "member_not_found", "Member not found.");
      const value = override === "inherit" ? null : override === "show";
      const updated = await client.query(
        `
          INSERT INTO member_usage_analytics_state (
            member_id, organization_id, visibility_override, updated_by_user_id, revision
          )
          SELECT $1, $2, $3, $4, 2
          WHERE $5 = 1
          ON CONFLICT (member_id) DO UPDATE SET
            visibility_override = EXCLUDED.visibility_override,
            revision = member_usage_analytics_state.revision + 1,
            updated_at = NOW(),
            updated_by_user_id = EXCLUDED.updated_by_user_id
          WHERE member_usage_analytics_state.organization_id = EXCLUDED.organization_id
            AND member_usage_analytics_state.revision = $5
          RETURNING revision
        `,
        [
          memberId,
          viewer.organization.id,
          value,
          viewer.user.id,
          expectedRevision,
        ],
      );
      if (!updated.rowCount) {
        throw new IdentityError(
          409,
          "revision_conflict",
          "Member visibility changed. Refresh and try again.",
        );
      }
      await recordAuditEvent(client, {
        action: "usage.member_visibility_updated",
        actorUserId: viewer.user.id,
        organizationId: viewer.organization.id,
        metadata: {
          effectiveForAdmin: isOrganizationAdministrator(
            member.rows[0].role as Role,
          ),
          override,
        },
        subjectId: memberId,
        subjectType: "member",
      });
      await client.query("COMMIT");
      return this.memberVisibility(headers, memberId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async members(
    headers: IncomingHttpHeaders,
    options: RangeOptions & {
      limit: number;
      offset: number;
      query: string;
      sort: "tokens" | "cost" | "activity";
    },
  ): Promise<UsageAnalyticsMembersResponse> {
    const viewer = await this.identity.requireAdmin(headers);
    const policy = await this.policy(viewer.organization.id);
    const effectiveFrom = policy.usage_retention_days
      ? `GREATEST($2::date, CURRENT_DATE - (${policy.usage_retention_days} - 1))`
      : "$2::date";
    const ordering =
      options.sort === "cost"
        ? "estimated_cost_microusd"
        : options.sort === "activity"
          ? "last_received_at"
          : "total_tokens";
    const result = await this.pool.query<{
      email: string | null;
      estimated_cost_microusd: string;
      cost_covered_tokens: string;
      last_received_at: Date | null;
      member_id: string | null;
      name: string;
      total_count: string;
      total_tokens: string;
      total_turns: string;
      visibility: "former" | "hidden" | "shown";
    }>(
      `
        WITH ranked AS (
          SELECT
            principals.member_id,
            CASE WHEN principals.anonymized THEN 'Former members' ELSE principals.display_name END AS name,
            CASE WHEN principals.anonymized THEN NULL ELSE principals.email END AS email,
            CASE
              WHEN principals.anonymized THEN 'former'
              WHEN members.role IN ('owner', 'admin') THEN 'shown'
              WHEN COALESCE(member_state.visibility_override, $7::boolean) THEN 'shown'
              ELSE 'hidden'
            END AS visibility,
            COALESCE(SUM(daily.input_tokens + daily.output_tokens + daily.cache_read_tokens + daily.cache_write_tokens), 0)::text AS total_tokens,
            COALESCE(SUM(daily.total_turns), 0)::text AS total_turns,
            COALESCE(SUM(daily.estimated_cost_microusd), 0)::text AS estimated_cost_microusd,
            COALESCE(SUM(daily.cost_covered_tokens), 0)::text AS cost_covered_tokens,
            MAX(daily.last_received_at) AS last_received_at
          FROM usage_analytics_principals principals
          LEFT JOIN member_usage_analytics_state member_state
            ON member_state.organization_id = principals.organization_id
           AND member_state.member_id = principals.member_id
          LEFT JOIN member members
            ON members."organizationId" = principals.organization_id
           AND members.id = principals.member_id
          LEFT JOIN usage_analytics_sources sources
            ON sources.organization_id = principals.organization_id
           AND sources.principal_id = principals.id
           AND sources.product = '${options.product === "work" ? "work" : "code"}'
          LEFT JOIN usage_analytics_daily daily
            ON daily.organization_id = sources.organization_id
           AND daily.source_id = sources.id
           AND daily.usage_date BETWEEN ${effectiveFrom} AND $3::date
          WHERE principals.organization_id = $1
            AND ($4 = '' OR principals.anonymized OR principals.display_name ILIKE '%' || $4 || '%' OR principals.email ILIKE '%' || $4 || '%')
          GROUP BY principals.id, member_state.visibility_override, members.role
        )
        SELECT ranked.*, COUNT(*) OVER()::text AS total_count
        FROM ranked
        ORDER BY ${ordering} DESC NULLS LAST, lower(name), member_id NULLS LAST
        LIMIT $5 OFFSET $6
      `,
      [
        viewer.organization.id,
        options.from,
        options.to,
        options.query,
        options.limit,
        options.offset,
        policy.usage_member_visibility_default,
      ],
    );
    const total = safeInteger(result.rows[0]?.total_count, "member count");
    const members: UsageAnalyticsMemberRow[] = result.rows.map((row) => ({
      ...(options.product === "work" ? { costCoveragePercent: Number(row.total_tokens) > 0 ? Math.min(100, safeInteger(row.cost_covered_tokens, "member priced tokens") / safeInteger(row.total_tokens, "member tokens") * 100) : 0 } : {}),
      ...(row.email ? { email: row.email } : {}),
      estimatedCostMicrousd: safeInteger(
        row.estimated_cost_microusd,
        "member estimated cost",
      ),
      id: row.member_id ?? "former-members",
      label: row.name,
      ...(row.last_received_at
        ? { lastReceivedAt: row.last_received_at.toISOString() }
        : {}),
      ...(row.member_id ? { memberId: row.member_id } : {}),
      totalTokens: safeInteger(row.total_tokens, "member tokens"),
      totalTurns: safeInteger(row.total_turns, "member turns"),
      visibility: row.visibility,
    }));
    return {
      members,
      pageInfo: {
        hasMore: options.offset + members.length < total,
        limit: options.limit,
        offset: options.offset,
        total,
      },
    };
  }

  public async deleteUsage(
    headers: IncomingHttpHeaders,
    expectedRevision: number,
    memberId?: string,
  ): Promise<{ deletedSources: number; epoch: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const viewer = await this.identity.requireAdminForMutation(
        headers,
        client,
      );
      const current = await this.policy(viewer.organization.id, client, true);
      if (
        safeInteger(current.usage_settings_revision, "settings revision") !==
        expectedRevision
      ) {
        throw new IdentityError(
          409,
          "revision_conflict",
          "Usage settings changed. Refresh and try again.",
        );
      }
      await recordAuditEvent(client, {
        action: memberId
          ? "usage.member_deletion_requested"
          : "usage.organization_deletion_requested",
        actorUserId: viewer.user.id,
        organizationId: viewer.organization.id,
        metadata: { epochWillRotate: true },
        subjectId: memberId ?? viewer.organization.id,
        subjectType: memberId ? "member" : "organization",
      });
      const epoch = randomUUID();
      let deletedSources = 0;
      if (memberId) {
        const member = await client.query(
          `SELECT 1 FROM member WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
          [memberId, viewer.organization.id],
        );
        if (!member.rowCount)
          throw new IdentityError(404, "member_not_found", "Member not found.");
        await client.query(
          `
            INSERT INTO member_usage_analytics_state (
              member_id, organization_id, collection_epoch, collection_started_at, updated_by_user_id
            ) VALUES ($1, $2, $3, NOW(), $4)
            ON CONFLICT (member_id) DO UPDATE SET
              collection_epoch = EXCLUDED.collection_epoch,
              collection_started_at = EXCLUDED.collection_started_at,
              updated_at = NOW(),
              updated_by_user_id = EXCLUDED.updated_by_user_id
            WHERE member_usage_analytics_state.organization_id = EXCLUDED.organization_id
          `,
          [memberId, viewer.organization.id, epoch, viewer.user.id],
        );
        await client.query(
          `
            UPDATE organization_policies
            SET revision = revision + 1,
                usage_settings_revision = usage_settings_revision + 1,
                usage_settings_updated_at = NOW(),
                usage_settings_updated_by_user_id = $2,
                updated_at = NOW(), updated_by_user_id = $2
            WHERE organization_id = $1
          `,
          [viewer.organization.id, viewer.user.id],
        );
        const removed = await client.query(
          `
            DELETE FROM usage_analytics_sources sources
            USING usage_analytics_principals principals
            WHERE sources.organization_id = $1
              AND principals.organization_id = $1
              AND principals.member_id = $2
              AND sources.principal_id = principals.id
            RETURNING sources.id
          `,
          [viewer.organization.id, memberId],
        );
        deletedSources = removed.rowCount ?? 0;
      } else {
        await client.query(
          `
            UPDATE organization_policies
            SET usage_analytics_epoch = $2, usage_analytics_started_at = NOW(),
                usage_settings_revision = usage_settings_revision + 1,
                usage_settings_updated_at = NOW(), usage_settings_updated_by_user_id = $3,
                revision = revision + 1, updated_at = NOW(), updated_by_user_id = $3
            WHERE organization_id = $1
          `,
          [viewer.organization.id, epoch, viewer.user.id],
        );
        await client.query(
          `
            UPDATE member_usage_analytics_state
            SET collection_epoch = NULL, collection_started_at = NULL,
                updated_at = NOW(), updated_by_user_id = $2
            WHERE organization_id = $1
          `,
          [viewer.organization.id, viewer.user.id],
        );
        const removed = await client.query(
          `DELETE FROM usage_analytics_sources WHERE organization_id = $1 RETURNING id`,
          [viewer.organization.id],
        );
        deletedSources = removed.rowCount ?? 0;
      }
      await recordAuditEvent(client, {
        action: memberId
          ? "usage.member_deleted"
          : "usage.organization_deleted",
        actorUserId: viewer.user.id,
        organizationId: viewer.organization.id,
        metadata: { deletedSources, epochRotated: true },
        subjectId: memberId ?? viewer.organization.id,
        subjectType: memberId ? "member" : "organization",
      });
      await client.query("COMMIT");
      return { deletedSources, epoch };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async cleanupExpired(): Promise<number> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [RETENTION_LOCK],
      );
      locked = Boolean(lock.rows[0]?.locked);
      if (!locked) return 0;
      const deleted = await client.query(
        `
          WITH expired AS (
            SELECT daily.tableoid, daily.ctid
            FROM usage_analytics_daily daily
            JOIN organization_policies policies ON policies.organization_id = daily.organization_id
            WHERE policies.usage_retention_days IS NOT NULL
              AND daily.usage_date < CURRENT_DATE - (policies.usage_retention_days - 1)
            ORDER BY daily.usage_date
            LIMIT 10000
          )
          DELETE FROM usage_analytics_daily daily
          USING expired
          WHERE daily.tableoid = expired.tableoid AND daily.ctid = expired.ctid
        `,
      );
      await client.query(
        `WITH expired AS (SELECT cloud.source_id,cloud.round_id FROM cloud_usage_rounds cloud JOIN organization_policies policies ON policies.organization_id=cloud.organization_id WHERE policies.usage_retention_days IS NOT NULL AND cloud.usage_date<CURRENT_DATE-(policies.usage_retention_days-1) ORDER BY cloud.usage_date LIMIT 10000) DELETE FROM cloud_usage_rounds cloud USING expired WHERE cloud.source_id=expired.source_id AND cloud.round_id=expired.round_id`,
      );
      return deleted.rowCount ?? 0;
    } finally {
      if (locked)
        await client.query("SELECT pg_advisory_unlock($1)", [RETENTION_LOCK]);
      client.release();
    }
  }

  public startRetentionWorker(log: {
    error(context: unknown, message: string): void;
  }): void {
    if (this.retentionTimer) return;
    const run = () => {
      void this.cleanupExpired().catch((error) =>
        log.error({ err: error }, "Usage retention cleanup failed"),
      );
    };
    run();
    this.retentionTimer = setInterval(run, 6 * 60 * 60 * 1_000);
    this.retentionTimer.unref();
  }

  public stopRetentionWorker(): void {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = undefined;
  }
}
