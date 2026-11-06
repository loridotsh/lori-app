import { priceUsage, type PricedUsage, type WorkPricing } from "./pricing.js";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
import type { PoolClient } from "pg";
import type { CloudReportedUsage } from "@lori-enterprise/contracts";
import { IdentityError } from "../auth/identity-service.js";
export interface CloudUsageAdmission {
  eligible: boolean;
  epoch: string;
  startedAt: string;
  admittedAt: string;
  sourceId: string;
}
export interface CloudUsageContext {
  pricingSnapshot?: WorkPricing | null;
  projectId?: string;
  organizationId: string;
  memberId: string;
  runId: string;
  roundId: string;
  providerId: string;
  modelId: string;
  usageDate: string;
  admission: CloudUsageAdmission | null;
  appVersion: string;
  kind?: "agent" | "text" | "title" | "memory" | "summary";
}
const KEYS = [
  "costMicrousd",
  "inputTokens",
  "outputTokens",
  "uncachedInputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheWrite5mTokens",
  "cacheWrite1hTokens",
  "reasoningTokens",
] as const;
export const unknownUsage = (): CloudReportedUsage =>
  Object.fromEntries(KEYS.map((k) => [k, null]));
function counter(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
export function mergeUsage(previous: PricedUsage | undefined, next: CloudReportedUsage, snapshot?: WorkPricing | null): PricedUsage {
  return priceUsage(Object.fromEntries(KEYS.map((k) => [k, counter(next[k]) ?? counter(previous?.[k])])),
    previous?.pricingSnapshot !== undefined ? previous.pricingSnapshot : snapshot);
}
export function normalizeProviderUsage(
  protocol: "openai" | "anthropic",
  raw: Record<string, unknown>,
): CloudReportedUsage {
  const input = counter(raw.input_tokens ?? raw.prompt_tokens),
    output = counter(raw.output_tokens ?? raw.completion_tokens);
  const details = (raw.input_tokens_details ?? raw.prompt_tokens_details) as
    | Record<string, unknown>
    | undefined;
  const outDetails = (raw.output_tokens_details ??
    raw.completion_tokens_details) as Record<string, unknown> | undefined;
  const read = counter(
      protocol === "anthropic"
        ? raw.cache_read_input_tokens
        : details?.cached_tokens,
    ),
    write = counter(
      protocol === "anthropic" ? raw.cache_creation_input_tokens : null,
    );
  const cost = typeof raw.cost === "number" && Number.isFinite(raw.cost) && raw.cost >= 0
    ? counter(Math.round(raw.cost * 1_000_000)) : null;
  return {
    costMicrousd: cost,
    inputTokens: input,
    outputTokens: output,
    uncachedInputTokens:
      protocol === "anthropic"
        ? input
        : input !== null && read !== null
          ? Math.max(0, input - read)
          : null,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    cacheWrite5mTokens: counter((raw.cache_creation as Record<string, unknown> | undefined)?.ephemeral_5m_input_tokens),
    cacheWrite1hTokens: counter((raw.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens),
    reasoningTokens: counter(outDetails?.reasoning_tokens),
  };
}
export async function captureCloudUsageAdmission(
  c: PoolClient,
  organizationId: string,
  memberId: string,
): Promise<CloudUsageAdmission> {
  const result = await c.query<{
    enabled: boolean;
    epoch: string;
    started_at: Date;
    admitted_at: Date;
  }>(
    `SELECT p.usage_analytics_enabled AS enabled,CASE WHEN s.collection_started_at>p.usage_analytics_started_at THEN s.collection_epoch ELSE p.usage_analytics_epoch END::text AS epoch,GREATEST(p.usage_analytics_started_at,COALESCE(s.collection_started_at,p.usage_analytics_started_at)) AS started_at,clock_timestamp() AS admitted_at FROM organization_policies p JOIN member m ON m.id=$2 AND m."organizationId"=p.organization_id LEFT JOIN member_usage_analytics_state s ON s.organization_id=p.organization_id AND s.member_id=m.id WHERE p.organization_id=$1 FOR SHARE OF p,m`,
    [organizationId, memberId],
  );
  const row = result.rows[0];
  if (!row)
    throw new IdentityError(
      403,
      "membership_required",
      "Organization membership is required.",
    );
  return {
    eligible: row.enabled && row.admitted_at >= row.started_at,
    epoch: row.epoch,
    startedAt: row.started_at.toISOString(),
    admittedAt: row.admitted_at.toISOString(),
    sourceId: randomUUID(),
  };
}
export async function recordCloudUsageRound(
  c: PoolClient,
  context: CloudUsageContext,
  sequence: number,
  usage: CloudReportedUsage,
) {
  const admission = context.admission;
  if (!admission?.eligible) return false;
  const current = await c.query<{
    enabled: boolean;
    epoch: string;
    started_at: Date;
    retention: number | null;
    principal_id: string;
  }>(
    `SELECT p.usage_analytics_enabled AS enabled,CASE WHEN s.collection_started_at>p.usage_analytics_started_at THEN s.collection_epoch ELSE p.usage_analytics_epoch END::text AS epoch,GREATEST(p.usage_analytics_started_at,COALESCE(s.collection_started_at,p.usage_analytics_started_at)) AS started_at,p.usage_retention_days AS retention,principal.id::text AS principal_id FROM organization_policies p JOIN member m ON m.id=$2 AND m."organizationId"=p.organization_id JOIN usage_analytics_principals principal ON principal.organization_id=p.organization_id AND principal.member_id=m.id AND NOT principal.anonymized LEFT JOIN member_usage_analytics_state s ON s.organization_id=p.organization_id AND s.member_id=m.id WHERE p.organization_id=$1 FOR SHARE OF p,m`,
    [context.organizationId, context.memberId],
  );
  const policy = current.rows[0];
  if (
    !policy?.enabled ||
    policy.epoch !== admission.epoch ||
    new Date(admission.admittedAt) < policy.started_at
  )
    return false;
  if (policy.retention) {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - (policy.retention - 1));
    if (context.usageDate < cutoff.toISOString().slice(0, 10)) return false;
  }
  const app = context.appVersion.length <= 40 ? context.appVersion : "unknown";
  await c.query(
    `INSERT INTO usage_analytics_sources(id,organization_id,principal_id,collection_epoch,last_device_id,app_version,product,enrolled_at,work_device_id,delivery_location) VALUES ($1,$2,$3,$4,NULL,$5,'work',$6,NULL,'cloud') ON CONFLICT(id) DO NOTHING`,
    [
      admission.sourceId,
      context.organizationId,
      policy.principal_id,
      admission.epoch,
      app,
      admission.admittedAt,
    ],
  );
  const source = (
    await c.query<{
      organization_id: string;
      principal_id: string;
      collection_epoch: string;
      enrolled_at: Date;
      delivery_location: string;
    }>(
      "SELECT organization_id,principal_id::text,collection_epoch::text,enrolled_at,delivery_location FROM usage_analytics_sources WHERE id=$1 FOR UPDATE",
      [admission.sourceId],
    )
  ).rows[0]!;
  if (
    source.organization_id !== context.organizationId ||
    source.principal_id !== policy.principal_id ||
    source.collection_epoch !== admission.epoch ||
    source.delivery_location !== "cloud" ||
    source.enrolled_at.toISOString() !==
      new Date(admission.admittedAt).toISOString()
  )
    throw new IdentityError(
      409,
      "usage_source_conflict",
      "Cloud usage source identity changed.",
    );
  const model =
    context.modelId.length <= 128 &&
    context.modelId.trim() === context.modelId &&
    !/[\u0000-\u001f\u007f]/.test(context.modelId)
      ? context.modelId
      : "";
  const agent = `work-${context.kind ?? "agent"}`;
  const old = (
    await c.query<{
      sequence: string;
      usage: PricedUsage;
      run_id: string;
      usage_date: string;
      agent_id: string;
      model: string;
      provider_id: string;
    }>(
      "SELECT sequence::text,usage,run_id::text,usage_date::text,agent_id,model,provider_id FROM cloud_usage_rounds WHERE source_id=$1 AND round_id=$2 FOR UPDATE",
      [admission.sourceId, context.roundId],
    )
  ).rows[0];
  if (
    old &&
    (old.run_id !== context.runId ||
      old.usage_date !== context.usageDate ||
      old.agent_id !== agent ||
      old.model !== model ||
      old.provider_id !== context.providerId)
  )
    throw new IdentityError(
      409,
      "usage_round_conflict",
      "Cloud usage round identity changed.",
    );
  if (old && Number(old.sequence) >= sequence) return false;
  const merged = mergeUsage(old?.usage, usage, context.pricingSnapshot);
  const read = merged.cacheReadTokens ?? null;
  const input =
    merged.uncachedInputTokens ??
    (read === null || read === 0 ? (merged.inputTokens ?? null) : null);
  await c.query(
    `INSERT INTO cloud_usage_rounds(source_id,organization_id,round_id,run_id,usage_date,agent_id,model,provider_id,sequence,usage,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(source_id,round_id) DO UPDATE SET sequence=EXCLUDED.sequence,usage=EXCLUDED.usage,input_tokens=EXCLUDED.input_tokens,output_tokens=EXCLUDED.output_tokens,cache_read_tokens=EXCLUDED.cache_read_tokens,cache_write_tokens=EXCLUDED.cache_write_tokens,reasoning_tokens=EXCLUDED.reasoning_tokens,last_received_at=NOW() WHERE cloud_usage_rounds.sequence<EXCLUDED.sequence`,
    [
      admission.sourceId,
      context.organizationId,
      context.roundId,
      context.runId,
      context.usageDate,
      agent,
      model,
      context.providerId,
      sequence,
      JSON.stringify(merged),
      input,
      merged.outputTokens ?? null,
      read,
      merged.cacheWriteTokens ?? null,
      merged.reasoningTokens ?? null,
    ],
  );
  await c.query("SELECT ensure_usage_analytics_partition($1::date)", [
    context.usageDate,
  ]);
  // This source is server-owned. Recompute from its deduplicated round ledger so late
  // cache details can replace inclusive input with exclusive input without double count.
  await c.query(
    `INSERT INTO usage_analytics_daily(usage_date,organization_id,source_id,agent_id,model,total_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,estimated_cost_microusd,cost_covered_tokens,app_version,pricing_version) SELECT usage_date,organization_id,source_id,agent_id,model,count(*),COALESCE(sum(input_tokens),0),COALESCE(sum(output_tokens),0),COALESCE(sum(cache_read_tokens),0),COALESCE(sum(cache_write_tokens),0),COALESCE(sum(COALESCE((usage->>'estimatedCostMicrousd')::bigint,(usage->>'costMicrousd')::bigint)),0),COALESCE(sum((usage->>'costCoveredTokens')::bigint),0),$4,'work-pricing-v2' FROM cloud_usage_rounds WHERE source_id=$1 AND usage_date=$2 AND agent_id=$3 GROUP BY usage_date,organization_id,source_id,agent_id,model ON CONFLICT(usage_date,organization_id,source_id,agent_id,model) DO UPDATE SET total_turns=EXCLUDED.total_turns,input_tokens=EXCLUDED.input_tokens,output_tokens=EXCLUDED.output_tokens,cache_read_tokens=EXCLUDED.cache_read_tokens,cache_write_tokens=EXCLUDED.cache_write_tokens,estimated_cost_microusd=EXCLUDED.estimated_cost_microusd,cost_covered_tokens=EXCLUDED.cost_covered_tokens,pricing_version=EXCLUDED.pricing_version,last_received_at=NOW()`,
    [admission.sourceId, context.usageDate, agent, app],
  );
  await c.query(
    "UPDATE usage_analytics_sources SET last_received_at=NOW() WHERE id=$1",
    [admission.sourceId],
  );
  return true;
}
/** Commit reported counters before forwarding their frame to the worker. The stream
 * remains byte-identical; no provider text, credential, prompt or error is persisted. */
export function cloudUsageObserver(
  protocol: "openai" | "anthropic",
  report: (usage: CloudReportedUsage) => Promise<void>,
) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const accumulated: Record<string, unknown> = {};
  async function inspect(chunk: Buffer, final = false) {
    pending += decoder.write(chunk);
    if (final) pending += decoder.end();

    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, match.index);
      if (Buffer.byteLength(frame) > 2 * 1024 * 1024)
        throw new Error("Provider event exceeds usage framing limit");
      pending = pending.slice(match.index + match[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(data);
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      } catch {
        continue;
      }
      const raw = (value.usage ??
        (value.message as Record<string, unknown> | undefined)?.usage ??
        (value.response as Record<string, unknown> | undefined)?.usage ??
        (value.x_groq as Record<string, unknown> | undefined)?.usage) as
        | Record<string, unknown>
        | undefined;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        // Providers can send input, cache and output counters in different frames.
        // Merge only bounded numeric usage fields before deriving exclusive input.
        for (const key of ["input_tokens", "prompt_tokens", "output_tokens", "completion_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "cost"]) {
          const value = raw[key];
          const valid = key === "cost"
            ? typeof value === "number" && value >= 0 && counter(Math.round(value * 1_000_000)) !== null
            : counter(value) !== null;
          if (valid) accumulated[key] = value;
        }
        for (const key of ["input_tokens_details", "prompt_tokens_details", "output_tokens_details", "completion_tokens_details", "cache_creation"]) {
          const details = raw[key];
          if (details && typeof details === "object" && !Array.isArray(details)) {
            const merged = { ...(accumulated[key] as Record<string, unknown> | undefined) };
            for (const field of ["cached_tokens", "reasoning_tokens", "ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]) {
              const value = (details as Record<string, unknown>)[field];
              if (counter(value) !== null) merged[field] = value;
            }
            accumulated[key] = merged;
          }
        }
        await report(normalizeProviderUsage(protocol, accumulated));
      }
    }
    if (Buffer.byteLength(pending) > 2 * 1024 * 1024)
      throw new Error("Provider event exceeds usage framing limit");
  }
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      void inspect(chunk).then(
        () => callback(null, chunk),
        () => callback(new Error("Cloud usage persistence failed")),
      );
    },
    flush(callback) {
      void inspect(Buffer.alloc(0), true).then(
        () => callback(),
        () => callback(new Error("Cloud usage persistence failed")),
      );
    },
  });
}
