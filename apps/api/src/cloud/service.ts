import { historyPage } from "./history.js";
import { CloudPersonalProjects } from "./personal-projects/service.js";
import { personalProjectArchived } from "./personal-projects/authorization.js";
import { CloudProjects } from "./projects/service.js";
import { requireDesktopProjectProtocol } from "./projects/protocol.js";
import { ProjectMemoryStore } from "./projects/memory.js";
import { ProjectRetrieval } from "./projects/retrieval.js";
import { clearProjectContext, openText, sealText, openJson, sealJson, projectContext } from "./projects/content.js";
import type { ProjectAction, Role } from "@lori-enterprise/contracts";
import { isOrganizationAdministrator } from "@lori-enterprise/contracts";
import { readContent } from "./projects/records.js";
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Pool, PoolClient } from "pg";
import type {
  CloudConversation,
  CloudRun,
  CloudEvent,
  CloudSettings,
  CloudSendMessage,
  CloudWorkerClaim,
  CloudEventType,
} from "@lori-enterprise/contracts";
import type { AppConfig } from "../config.js";
import type { IdentityService } from "../auth/identity-service.js";
import { IdentityError } from "../auth/identity-service.js";
import type { EnrollmentService } from "../auth/enrollment-service.js";
import type { WorkService } from "../auth/work-service.js";
import type { ProviderGatewayService } from "../auth/provider-gateway-service.js";
import { cachedWorkModels, listsModelLimits } from "../auth/work-model-discovery.js";
import { providerGatewayDefinition } from "../catalog.js";
import { recordAuditEvent } from "../auth/audit.js";
import {
  fingerprint,
  readLease,
  secureEqual,
  signLease,
  type LeaseClaims,
} from "./security.js";
export interface CloudActor {
  /** Assigned only by project routes or a verified run, never a request header. */
  projectId?: string;
  projectManagement?: boolean;
  /** Untrusted UI selector, checked against the resource's actual project. */
  selectedProjectId?: string;
  organizationId: string;
  memberId: string;
  userId: string;
  role: string;
  deviceId?: string;
  sessionId?: string;
  browserSessionId?: string;
  headers?: IncomingHttpHeaders;
}
type Row = {
  latest_run_status?: CloudRun["status"] | null;
  project_id: string | null;
  personal_project_id?: string | null;
  is_project_root?: boolean;
  id: string;
  organization_id: string;
  member_id: string;
  conversation_id: string;
  title: string;
  revision: number;
  created_at: Date;
  updated_at: Date;
  status: CloudRun["status"];
  gateway_id: string;
  model_id: string;
  error_code: string | null;
  finish_reason: string | null;
  last_sequence: number;
  assistant_text: string;
  lease_id: string;
  lease_version: number;
  lease_until: Date;
  request_id: string;
  fingerprint: string;
  provider_started: boolean;
  worker_capabilities: Record<string, boolean>;
  usage_admission: CloudUsageAdmission | null;
  worker_id: string;
  admitted_device_id: string | null;
  admitted_device_session_id: string | null;
  admitted_browser_session_id: string | null;
};
/**
 * Why the company provider refused or failed a request, safe to show to the
 * member. Only the category is stored: upstream bodies and keys never are.
 */
export const PROVIDER_FAILURES = [
  "provider_auth_failed",
  "provider_model_unavailable",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_request_rejected",
  "provider_insufficient_balance",
  "provider_response_too_large",
  "provider_context_exceeded",
  // The conversation has no room left for a generated file.
  "work_files_full",
  // The model asked for a tool that does not exist or sent unreadable arguments.
  // Reported by the worker (the only category it may name), never by a provider.
  "model_tool_call_invalid",
] as const;
export type ProviderFailure = (typeof PROVIDER_FAILURES)[number];
/**
 * Short machine identifiers from a provider error body (`error.code`,
 * `error.type`, `error.param`) for diagnostics. The human message is never
 * returned: it can echo request content.
 */
export function upstreamErrorFields(body: string): {
  code?: string;
  type?: string;
  param?: string;
} {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    const error =
      parsed && typeof parsed.error === "object" && parsed.error
        ? (parsed.error as Record<string, unknown>)
        : {};
    const out: { code?: string; type?: string; param?: string } = {};
    for (const key of ["code", "type", "param"] as const) {
      const value = error[key];
      // Brackets are how a provider names the field it refused: messages[12].content.
      if (typeof value === "string" && /^[A-Za-z0-9_.:[\]-]{1,64}$/.test(value))
        out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}
/**
 * Whether a provider's 400/422 body says the model itself is unknown or
 * unusable. Deliberately narrow: many providers echo the word "model" in
 * unrelated errors (for example "This model's maximum context length is…"),
 * and those must not read as an unavailable model.
 */
export function mentionsUnknownModel(body: string): boolean {
  if (
    /context[_ ]length|maximum context|too many tokens|token limit|max_tokens|reduce the length/i.test(
      body,
    )
  )
    return false;
  return /model[_ ]not[_ ]found|(?:invalid|unknown|unsupported|unrecognized|no such|not a valid) model|model\b[^."]{0,80}\b(?:does not exist|not found|is not available|is not supported|not supported|unavailable|decommissioned|deprecated)|"param"\s*:\s*"model"/i.test(
    body,
  );
}
/** Whether a provider body says the request exceeded the model's context window. */
export function mentionsContextOverflow(body: string): boolean {
  return /context_length_exceeded|maximum context length|context (?:length|window)[^."]{0,60}(?:exceed|too (?:long|large))|exceeds? the (?:context|token) limit|too many tokens|prompt is too long|reduce the length of the messages/i.test(
    body,
  );
}
export function providerFailureFor(
  status: number,
  mentionsModel = false,
  contextExceeded = false,
): ProviderFailure {
  // A payload the provider calls too large is a context problem, whatever the wording.
  if (status === 413 || (contextExceeded && status >= 400 && status < 500))
    return "provider_context_exceeded";
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 402) return "provider_insufficient_balance";
  if (status === 404 || ((status === 400 || status === 422) && mentionsModel))
    return "provider_model_unavailable";
  if (status === 408 || status === 429) return "provider_rate_limited";
  if (status === 0 || status >= 500) return "provider_unavailable";
  return "provider_request_rejected";
}
function iso(d: Date): string {
  return d.toISOString();
}
export function conversationView(r: Row): CloudConversation {
  return conversation(r);
}
function conversation(r: Row): CloudConversation {
  return {
    ...(r.latest_run_status !== undefined ? { latestRunStatus: r.latest_run_status } : {}),
    ...(r.project_id ? { projectId: r.project_id } : {}),
    ...(r.personal_project_id ? { personalProjectId: r.personal_project_id } : {}),
    id: r.id,
    title: r.title,
    revision: r.revision,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
function run(r: Row): CloudRun {
  return {
    ...(r.project_id ? { projectId: r.project_id, initiatedBy: r.member_id } : {}),
    id: r.id,
    conversationId: r.conversation_id,
    status: r.status,
    gatewayId: r.gateway_id,
    modelId: r.model_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    errorCode: r.error_code,
    lastSequence: r.last_sequence,
  };
}
/** What an archived personal project refuses; reading, filing a chat out and deleting stay possible. */
const ARCHIVED_BLOCKED = new Set<ProjectAction>(["chat", "files.write"]);
/** 0G's full listing takes about two seconds; only the first load after a start waits for it. */
const LIMIT_PRIME_TIMEOUT_MS = 4000;
function denied(code = "cloud_access_denied"): never {
  throw new IdentityError(403, code, "Enterprise Cloud access is unavailable.");
}
function conflict(code = "cloud_revision_conflict"): never {
  throw new IdentityError(
    409,
    code,
    "The conversation changed. Refresh and try again.",
  );
}
import { CloudFiles } from "./files.js";
import { CloudTools, PERSONAL_PROJECT_TOOLS, approval, getCloudTools, invocation } from "./tools.js";
import { UsageAnalyticsService } from "../usage/service.js";
import type { CloudUsageAdmission } from "./usage.js";
import { CloudExtensions } from "./extensions/service.js";
import { CloudMemory } from "./memory.js";
import { SemanticEmbedder } from "./semantic/embedder.js";
import { CloudResearch } from "./research.js";
import { CloudPreferences } from "./preferences.js";
import { CloudRounds } from "./rounds.js";
import { ModelLimitResolver, type LimitTarget } from "./model-limit-discovery.js";
import { MAX_RESPONSE_TOKENS } from "./model-limits.js";
import { MAX_ROUNDS } from "./run-budget.js";
export class CloudWorkService {
  readonly personalProjects: CloudPersonalProjects;
  readonly projects: CloudProjects;
  readonly projectMemory: ProjectMemoryStore;
  readonly projectRetrieval: ProjectRetrieval;
  readonly files: CloudFiles;
  readonly tools: CloudTools;
  readonly rounds: CloudRounds;
  readonly memory: CloudMemory;
  /** Local multilingual embeddings; absent assets or the kill switch leave retrieval lexical. */
  readonly semantic = new SemanticEmbedder();
  readonly research: CloudResearch;
  readonly preferences: CloudPreferences;
  readonly extensions: CloudExtensions;
  readonly analytics: UsageAnalyticsService;
  /** Each model's real context window, from the provider where it says (cached) and learned from refusals. */
  readonly limits: ModelLimitResolver;
  definitions(isolated = false) {
    return [...getCloudTools(isolated), ...this.extensions.definitions()].filter(
      (tool) => this.config.cloud?.webResearchEnabled !== false || !["web_search", "web_fetch"].includes(tool.name),
    );
  }
  async allowedDefinitions(
    c: PoolClient,
    org: string,
    member: string,
    user: string,
    isolated = false,
    /** The conversation is filed in a personal project: its reference tools are offered, and only then. */
    personalProject = false,
  ) {
    const memory = await this.memory.settingsTx(c, {
      organizationId: org,
      memberId: member,
      userId: user,
      role: "member",
    });
    return this.definitions(isolated).filter(
      (t) =>
        (!t.name.startsWith("memory_") || (memory.enabled && memory.allowed)) &&
        (personalProject || !PERSONAL_PROJECT_TOOLS.has(t.name)),
    );
  }
  workPolicy(org: string, member: string, c: PoolClient) {
    return this.work.effectiveForMember(org, member, c);
  }
  constructor(
    public readonly pool: Pool,
    public readonly config: AppConfig,
    private readonly identity: IdentityService,
    private readonly enrollment: EnrollmentService,
    readonly work: WorkService,
    public readonly providers: ProviderGatewayService,
  ) {
    this.limits = new ModelLimitResolver(config.cloud?.modelLimits);
    this.projects = new CloudProjects(this);
    this.personalProjects = new CloudPersonalProjects(this);
    this.projectMemory = new ProjectMemoryStore(this);
    this.projectRetrieval = new ProjectRetrieval(this);
    this.files = new CloudFiles(this);
    this.tools = new CloudTools(this);
    this.rounds = new CloudRounds(this);
    this.memory = new CloudMemory(this);
    this.research = new CloudResearch(config.cloud?.researchApiKey);
    this.preferences = new CloudPreferences(this);
    this.extensions = new CloudExtensions(this);
    this.analytics = new UsageAnalyticsService(
      pool,
      identity,
      enrollment,
      work,
    );
  }
  async throttleProvider(
    gatewayId: string,
    memberId: string,
    requestsPerMinute: number,
  ) {
    await this.identity.enforceRateLimit(
      `cloud-provider:${gatewayId}:${memberId}`,
      requestsPerMinute,
      60,
    );
  }
  async throttleRead(memberId: string) {
    await this.identity.enforceRateLimit(`cloud-read:${memberId}`, 120, 60);
  }
  /** Scrolling a document polls once per visible page, so previews get their own, larger bucket. */
  async throttlePreview(memberId: string) {
    await this.identity.enforceRateLimit(`cloud-preview:${memberId}`, 900, 60);
  }
  async throttleMutation(memberId: string) {
    await this.identity.enforceRateLimit(`cloud-mutation:${memberId}`, 120, 60);
  }
  async actor(headers: IncomingHttpHeaders): Promise<CloudActor> {
    const project = headers["x-lori-project-id"];
    if (project !== undefined && (typeof project !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(project)))
      throw new IdentityError(400, "project_selector_invalid", "Invalid project selection.");
    if (headers.authorization) {
      const d = await this.enrollment.authenticatedDevice(
        headers.authorization,
      );
      if (project) requireDesktopProjectProtocol(headers);
      return {
        ...(project ? { selectedProjectId: project } : {}),
        organizationId: d.organizationId,
        memberId: d.memberId,
        userId: d.userId,
        role: "member",
        deviceId: d.deviceId,
        sessionId: d.sessionId,
        headers,
      };
    }
    const { viewer: v, sessionId: browserSessionId } =
      await this.identity.getCloudIdentity(headers);
    const m = await this.pool.query<{
      id: string;
    }>('SELECT id FROM member WHERE "organizationId"=$1 AND "userId"=$2', [
      v.organization.id,
      v.user.id,
    ]);
    if (!m.rows[0]) denied();
    return {
      ...(project ? { selectedProjectId: project } : {}),
      organizationId: v.organization.id,
      memberId: m.rows[0].id,
      userId: v.user.id,
      role: v.role,
      browserSessionId,
      headers,
    };
  }
  async transaction<T>(operation: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL statement_timeout='10s'");
      await c.query("SET LOCAL lock_timeout='5s'");
      const result = await operation(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      if (
        e &&
        typeof e === "object" &&
        "code" in e &&
        (e.code === "55P03" || e.code === "57014")
      )
        throw new IdentityError(
          503,
          "cloud_busy",
          "Cloud is busy. Retry shortly.",
        );
      throw e;
    } finally {
      clearProjectContext(c);
      c.release();
    }
  }
  async ensure(
    c: PoolClient,
    a: CloudActor,
    enabled = true,
  ): Promise<CloudSettings> {
    const scope = projectContext(c);
    if (scope && scope.organizationId !== a.organizationId) denied("project_scope_mismatch");
    await c.query("SELECT set_config('lori.organization_id',$1,true)", [a.organizationId]);
    await c.query(
      "SELECT organization_id FROM organization_policies WHERE organization_id=$1 FOR SHARE",
      [a.organizationId],
    );
    const m = await c.query(
      'SELECT id FROM member WHERE id=$1 AND "organizationId"=$2 AND "userId"=$3 FOR SHARE',
      [a.memberId, a.organizationId, a.userId],
    );
    if (!m.rowCount) denied();
    // Row-level security for owner-only data follows the verified membership, never a request field.
    await c.query("SELECT set_config('lori.member_id',$1,true)", [a.memberId]);
    if (a.deviceId) {
      const valid = await c.query(
        "SELECT 1 FROM devices d JOIN device_sessions s ON s.device_id=d.id WHERE d.id=$1 AND d.organization_id=$2 AND d.user_id=$3 AND d.revoked_at IS NULL AND s.id=$4 AND s.revoked_at IS NULL AND s.access_expires_at>NOW() FOR SHARE OF d,s",
        [a.deviceId, a.organizationId, a.userId, a.sessionId],
      );
      if (!valid.rowCount) denied();
    }
    await this.assertSession(c, a);
    await c.query(
      "INSERT INTO cloud_work_settings(organization_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [a.organizationId],
    );
    const s = (
      await c.query<{
        enabled: boolean;
        retention_days: number;
        revision: number;
      }>(
        "SELECT * FROM cloud_work_settings WHERE organization_id=$1 FOR SHARE",
        [a.organizationId],
      )
    ).rows[0]!;
    if (enabled && (!s.enabled || !this.config.cloud?.workerSecret))
      denied("cloud_disabled");
    const p = await this.work.effectiveForMember(
      a.organizationId,
      a.memberId,
      c,
    );
    if (enabled && !p.enabled) denied("work_disabled");
    return {
      enabled: s.enabled,
      retentionDays: s.retention_days,
      revision: s.revision,
    };
  }
  async assertSession(c: PoolClient, a: CloudActor) {
    if (a.browserSessionId) {
      const valid = await c.query(
        'SELECT 1 FROM session WHERE id=$1 AND "userId"=$2 AND "expiresAt">NOW() FOR SHARE',
        [a.browserSessionId, a.userId],
      );
      if (!valid.rowCount) denied("cloud_session_revoked");
    }
  }
  /** Organization administrator (Owner or Admin), from the verified membership row. */
  async isAdministrator(c: PoolClient, a: Pick<CloudActor, "organizationId" | "memberId">) {
    const member = await c.query<{ role: string }>(
      'SELECT role FROM member WHERE id=$1 AND "organizationId"=$2',
      [a.memberId, a.organizationId],
    );
    return isOrganizationAdministrator(member.rows[0]?.role as Role | undefined);
  }
  async settings(a: CloudActor) {
    if (!isOrganizationAdministrator(a.role as Role)) denied("admin_required");
    return this.transaction(async (c) => {
      const settings = await this.ensure(c, a, false);
      if (!(await this.isAdministrator(c, a))) denied("admin_required");
      return settings;
    });
  }
  /** A browser administrator session; device tokens never change organization policy. */
  async requireAdminMutation(c: PoolClient, a: CloudActor) {
    if (!a.headers || a.headers.authorization) denied("admin_required");
    const v = await this.identity.requireAdminForMutation(a.headers, c);
    await this.assertSession(c, a);
    if (v.organization.id !== a.organizationId) denied();
  }
  async updateSettings(
    a: CloudActor,
    input: {
      retentionDays: number;
      expectedRevision: number;
    },
  ) {
    return this.transaction(async (c) => {
      if (!a.headers || a.headers.authorization) denied("admin_required");
      const v = await this.identity.requireAdminForMutation(a.headers, c);
      await this.assertSession(c, a);
      if (v.organization.id !== a.organizationId) denied();
      await c.query(
        "INSERT INTO cloud_work_settings(organization_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [a.organizationId],
      );
      const s = await c.query<{
        enabled: boolean;
        retention_days: number;
        revision: number;
      }>(
        "UPDATE cloud_work_settings SET enabled=TRUE,retention_days=$2,revision=revision+1 WHERE organization_id=$1 AND revision=$3 RETURNING *",
        [a.organizationId, input.retentionDays, input.expectedRevision],
      );
      if (!s.rows[0]) conflict();
      await recordAuditEvent(c, {
        action: "work.cloud.settings.updated",
        actorUserId: a.userId,
        organizationId: a.organizationId,
        metadata: { retentionDays: input.retentionDays },
      });
      return {
        enabled: s.rows[0].enabled,
        retentionDays: s.rows[0].retention_days,
        revision: s.rows[0].revision,
      };
    });
  }
  /**
   * Asks providers for real model windows before the capabilities transaction: a
   * listing answers for all its models at once, and any other allowed model is
   * resolved in the background. Bounded, so a slow provider never holds the page.
   */
  private async primeModelLimits(organizationId: string) {
    const rows = await this.pool.query<{ provider_id: string; encrypted_api_key: string }>(
      "SELECT provider_id,encrypted_api_key FROM organization_provider_gateways WHERE organization_id=$1",
      [organizationId],
    );
    const listings = rows.rows.flatMap((row) => {
      const target = this.providers.limitTarget(organizationId, row.provider_id, row.encrypted_api_key);
      if (!target || !listsModelLimits(row.provider_id)) return [];
      const known = this.limits.primed(target);
      const listing = cachedWorkModels(target).then((models) => this.limits.prime(target, models));
      return known ? [] : [listing];
    });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(listings),
      new Promise((resolve) => { timer = setTimeout(resolve, LIMIT_PRIME_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
  }
  async capabilities(a: CloudActor) {
    await this.primeModelLimits(a.organizationId).catch(() => undefined);
    return this.transaction(async (c) => {
      const s = await this.ensure(c, a, false);
      // A selected shared project scopes models to its assignment; the selector
      // itself grants nothing, it is authorized like any project read.
      const project =
        a.selectedProjectId && (await this.projects.ready(c))
          ? (await this.projects.authorize(c, a, a.selectedProjectId)).row
          : undefined;
      const scope = await this.work.resourceScope(
        a.organizationId,
        a.memberId,
        c,
        project?.policy,
      );
      const policy = scope.policy;
      const rows = await c.query<{
        id: string;
        provider_id: string;
        encrypted_api_key: string;
      }>(
        "SELECT id,provider_id,encrypted_api_key FROM organization_provider_gateways WHERE organization_id=$1",
        [a.organizationId],
      );
      const healthy = await c.query(
        "SELECT capabilities FROM cloud_work_workers WHERE last_seen_at>NOW()-INTERVAL '45 seconds' LIMIT 100",
      );
      const limitsFor = (providerId: string, models: string[], target?: LimitTarget) =>
        Object.fromEntries(
          models.map((id) => {
            const limits = this.limits.peek(providerId, id, target);
            return [
              id,
              {
                contextTokens: limits.contextTokens,
                outputTokens: limits.outputTokens,
              },
            ];
          }),
        );
      const mediaFor = (providerId: string, models: string[], target?: LimitTarget) =>
        Object.fromEntries(
          models.flatMap((id) => {
            const media = this.limits.media(providerId, id, target);
            return media ? [[id, media]] : [];
          }),
        );
      const providers = rows.rows.flatMap((r) => {
        const models = scope.models(r.provider_id);
        if (!models.length) return [];
        const d = providerGatewayDefinition(r.provider_id);
        const target = this.providers.limitTarget(a.organizationId, r.provider_id, r.encrypted_api_key) ?? undefined;
        if (target && !listsModelLimits(r.provider_id))
          for (const id of models) void this.limits.resolve(target, id).catch(() => undefined);
        return [
          {
            gatewayId: r.id,
            providerId: r.provider_id,
            name: d.name,
            modelIds: models,
            modelLimits: limitsFor(r.provider_id, models, target),
            modelMedia: mediaFor(r.provider_id, models, target),
          },
        ];
      });
      return {
        contractVersion: 1 as const,
        // Work policy (Manage Work Access) is the single source of truth.
        enabled: s.enabled && policy.enabled,
        available: !!this.config.cloud?.workerSecret && !!healthy.rowCount,
        providers,
        features: {
          chat: true,
          files: true,
          tools: healthy.rows.some((row) => row.capabilities?.tools === true),
          extensions: true,
          memory: policy.memoryAllowed,
          personalProjects: true,
        },
      };
    });
  }
  async ownConversation(
    c: PoolClient,
    a: CloudActor,
    id: string,
    lock = false,
    action: ProjectAction = "read",
  ) {
    const projectId = await this.projects.resource(c, a, "conversation", id, action);
    const r = await c.query<Row>(
      `SELECT * FROM cloud_work_conversations WHERE id=$1 AND organization_id=$2 AND (member_id=$3 OR project_id=$4) ${lock ? "FOR UPDATE" : ""}`,
      [id, a.organizationId, a.memberId, projectId],
    );
    if (!r.rows[0])
      throw new IdentityError(
        404,
        "cloud_not_found",
        "Cloud conversation was not found.",
      );
    if (r.rows[0].personal_project_id) {
      // A chat filed in a deleted project is gone for everyone; an archived project is read-only.
      await this.personalProjects.authorization.bind(c, a);
      const project = (
        await c.query<{ status: string }>(
          "SELECT status FROM cloud_work_personal_projects WHERE id=$1 AND organization_id=$2 AND member_id=$3",
          [r.rows[0].personal_project_id, a.organizationId, a.memberId],
        )
      ).rows[0];
      if (!project || project.status === "deleted")
        throw new IdentityError(404, "cloud_not_found", "Cloud conversation was not found.");
      if (project.status === "archived" && ARCHIVED_BLOCKED.has(action)) throw personalProjectArchived();
    }
    return { ...r.rows[0], title: openText(c, "conversation", id, "title", r.rows[0].title) };
  }
  /**
   * A team workspace's conversations, a personal project's, or (neither given)
   * the member's private conversations that are outside any personal project.
   */
  async list(a: CloudActor, limit: number, cursor?: string, projectId?: string, personalProjectId?: string, placement: "all" | "unfiled" = "all") {
    return this.transaction(async (c) => {
      await this.ensure(c, a);
      if (projectId && personalProjectId) throw new IdentityError(400, "personal_project_scope", "Choose a team workspace or a personal project, not both.");
      if (projectId) await this.projects.authorize(c, a, projectId);
      if (personalProjectId) await this.personalProjects.authorization.own(c, a, personalProjectId);
      const unfiledOnly = !projectId && !personalProjectId && placement === "unfiled";
      const privateAll = !projectId && !personalProjectId && placement === "all";
      if (cursor) {
        const anchor = await this.ownConversation(c, a, cursor);
        const sameScope = privateAll
          ? !anchor.project_id
          : (anchor.project_id ?? null) === (projectId ?? null) && (anchor.personal_project_id ?? null) === (personalProjectId ?? null);
        if (!sameScope) throw new IdentityError(404, "cloud_history_cursor_invalid", "The cursor does not belong to this history.");
      }
      // A private conversation is listed when it is unfiled, or when the personal project it is filed in still exists.
      const placed = `(project_id IS NULL AND member_id=$2 AND $5::uuid IS NULL AND (
          ($6::uuid IS NOT NULL AND personal_project_id=$6::uuid)
          OR ($6::uuid IS NULL AND $7::boolean AND personal_project_id IS NULL)
          OR ($6::uuid IS NULL AND NOT $7::boolean AND (personal_project_id IS NULL OR EXISTS(SELECT 1 FROM cloud_work_personal_projects pp WHERE pp.id=personal_project_id AND pp.organization_id=$1 AND pp.member_id=$2 AND pp.status<>'deleted')))
        )) OR project_id=$5`;
      const r = await c.query<Row>(
        `SELECT cloud_work_conversations.*, (SELECT status FROM cloud_work_runs
           WHERE conversation_id=cloud_work_conversations.id ORDER BY created_at DESC,id DESC LIMIT 1) AS latest_run_status
         FROM cloud_work_conversations
         WHERE organization_id=$1 AND NOT is_project_root AND (${placed})
           AND ($3::uuid IS NULL OR (updated_at,id)<(
             SELECT updated_at,id FROM cloud_work_conversations
             WHERE id=$3::uuid AND organization_id=$1 AND (${placed})
           ))
         ORDER BY updated_at DESC,id DESC LIMIT $4`,
        [a.organizationId, a.memberId, cursor ?? null, limit + 1, projectId ?? null, personalProjectId ?? null, unfiledOnly],
      );
      return {
        conversations: r.rows.slice(0, limit).map(row => conversation({ ...row, title: openText(c, "conversation", row.id, "title", row.title) })),
        nextCursor: r.rows.length > limit ? r.rows[limit - 1]!.id : null,
      };
    });
  }
  async create(a: CloudActor, title: string, projectId?: string, requestId?: string) {
    return this.transaction(async (c) => {
      await this.ensure(c, a);
      if (projectId) await this.projects.authorize(c, a, projectId, "chat");
      const id = projectId && requestId ? requestId : randomUUID();
      const creationFingerprint = projectId ? fingerprint({ projectId, memberId: a.memberId, title }) : null;
      if (projectId && requestId) {
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project-conversation:${id}`]);
        const old = (await c.query<Row & { creation_fingerprint: string }>("SELECT * FROM cloud_work_conversations WHERE id=$1 AND project_id=$2", [id, projectId])).rows[0];
        if (old) {
          if (old.creation_fingerprint !== creationFingerprint) conflict("cloud_idempotency_conflict");
          return conversation({ ...old, title: openText(c, "conversation", id, "title", old.title) });
        }
      }
      const r = await c.query<Row>(
        "INSERT INTO cloud_work_conversations(id,organization_id,member_id,title,project_id,created_by,creation_fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [id, a.organizationId, projectId ? null : a.memberId, sealText(c, "conversation", id, "title", title), projectId ?? null, a.memberId, creationFingerprint],
      );
      return conversation({ ...r.rows[0]!, title });
    });
  }
  async detail(a: CloudActor, id: string, before?: string) {
    return this.transaction(async (c) => {
      await this.ensure(c, a);
      const conv = await this.ownConversation(c, a, id, true);
      const files = await this.files.listTx(c, id);
      const page = await historyPage(c, id, files, before);
      const r = await c.query<Row>(
        "SELECT * FROM cloud_work_runs WHERE conversation_id=$1 AND (id=ANY($2::uuid[]) OR id IN (SELECT id FROM cloud_work_runs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 20)) ORDER BY created_at DESC",
        [id, [...new Set(page.messages.map(message => message.runId))]],
      );
      const activities = await this.tools.snapshotTx(
        c,
        before ? [...new Set(page.messages.map(message => message.runId))] : r.rows.map((x) => x.id),
      );
      return {
        ...activities,
        files,
        conversation: conversation({ ...conv, latest_run_status: r.rows[0]?.status ?? null }),
        ...page,
        runs: r.rows.map(run),
      };
    });
  }
  async rename(a: CloudActor, id: string, title: string, revision: number) {
    return this.transaction(async (c) => {
      await this.ensure(c, a);
      const r = await this.ownConversation(c, a, id, true, "chat");
      if (r.revision !== revision) conflict();
      return conversation(
        { ...(
          await c.query<Row>(
            "UPDATE cloud_work_conversations SET title=$2,revision=revision+1,updated_at=NOW() WHERE id=$1 RETURNING *",
            [id, sealText(c, "conversation", id, "title", title)],
          )
        ).rows[0]!, title },
      );
    });
  }
  async remove(a: CloudActor, id: string, revision: number) {
    return this.transaction(async (c) => {
      await this.ensure(c, a);
      const r = await this.ownConversation(c, a, id, true, "conversations.delete");
      if (r.is_project_root) denied("project_root_protected");
      if (r.revision !== revision) conflict();
      const active = await c.query(
        "SELECT 1 FROM cloud_work_runs WHERE conversation_id=$1 AND status IN ('queued','running','awaitingApproval')",
        [id],
      );
      if (active.rowCount) conflict("cloud_run_active");
      await c.query("DELETE FROM cloud_work_conversations WHERE id=$1", [id]);
      if (r.project_id) await this.projects.invalidate(c, r.project_id);
    });
  }
  async submit(a: CloudActor, id: string, input: CloudSendMessage) {
    return this.transaction(async (c) => {
      await this.ensure(c, a);
      const conv = await this.ownConversation(c, a, id, true, "chat");
      if (conv.is_project_root) denied("project_root_protected");
      if (conv.personal_project_id) {
        // Shared lock: archiving or deleting the project waits for this admission and then sees the new run.
        const project = await this.personalProjects.authorization.own(c, a, conv.personal_project_id, { lock: "share" });
        this.personalProjects.authorization.requireActive(project);
      }
      const fp = fingerprint({
        conversationId: id,
        text: input.text,
        gatewayId: input.gatewayId,
        modelId: input.modelId,
        expectedRevision: input.expectedRevision,
        attachmentIds: input.attachmentIds ?? [],
      });
      const old = await c.query<Row>(
        "SELECT * FROM cloud_work_runs WHERE organization_id=$1 AND member_id=$2 AND request_id=$3",
        [a.organizationId, a.memberId, input.requestId],
      );
      if (old.rows[0]) {
        if (old.rows[0].fingerprint !== fp)
          conflict("cloud_idempotency_conflict");
        return { conversation: conversation(conv), run: run(old.rows[0]) };
      }
      if (conv.revision !== input.expectedRevision) conflict();
      // Inside a shared project, the project's resource assignment decides the models.
      const project = conv.project_id
        ? (await this.projects.authorize(c, a, conv.project_id, "chat")).row
        : undefined;
      const target = await this.providers.authorizeCloudRequest(
        a.organizationId,
        a.memberId,
        input.gatewayId,
        c,
        project?.policy,
      );
      if (!target.allowedModels.includes(input.modelId))
        denied("cloud_model_denied");
      if (conv.project_id) {
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project-queue:${conv.project_id}`]);
        const count = await c.query<{ n: string }>("SELECT count(*) AS n FROM cloud_work_project_run_queue WHERE project_id=$1 AND status IN ('queued','running','awaitingApproval')", [conv.project_id]);
        if (Number(count.rows[0]!.n) >= 4) throw new IdentityError(429, "project_queue_full", "This project has four active tasks. Wait for one to finish.");
      }
      // Organization queue quota is serialized independently from unrelated
      // organizations. The global ceiling below is a soft limit on purpose: a
      // lock here would make every tenant's sends wait on each other.
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `cloud-queue:${a.organizationId}`,
      ]);
      const global = await c.query<{
        n: string;
      }>(
        "SELECT (SELECT count(*) FROM cloud_work_runs WHERE project_id IS NULL AND status IN ('queued','running','awaitingApproval'))+(SELECT count(*) FROM cloud_work_project_run_queue WHERE status IN ('queued','running','awaitingApproval')) AS n",
      );
      if (Number(global.rows[0]!.n) >= 1000)
        throw new IdentityError(
          429,
          "cloud_queue_full",
          "Cloud queue is full. Try again shortly.",
        );
      const count = await c.query<{
        n: string;
      }>(
        "SELECT (SELECT count(*) FROM cloud_work_runs WHERE organization_id=$1 AND project_id IS NULL AND status IN ('queued','running','awaitingApproval'))+(SELECT count(*) FROM cloud_work_project_run_queue WHERE organization_id=$1 AND status IN ('queued','running','awaitingApproval')) AS n",
        [a.organizationId],
      );
      // On the hosted cloud the workers are shared with strangers.
      if (Number(count.rows[0]!.n) >= (this.config.auth.publicSignup ? 12 : 100))
        throw new IdentityError(
          429,
          "cloud_queue_full",
          "Cloud queue is full. Try again shortly.",
        );
      const active = await c.query(
        "SELECT 1 FROM cloud_work_runs WHERE conversation_id=$1 AND status IN ('queued','running','awaitingApproval')",
        [id],
      );
      if (active.rowCount) conflict("cloud_run_active");
      const budget = await c.query<{
        bytes: string;
        n: string;
      }>(
        "SELECT COALESCE(sum(CASE WHEN project_id IS NULL THEN octet_length(text) ELSE content_bytes END),0) AS bytes,count(*) AS n FROM cloud_work_messages WHERE conversation_id=$1",
        [id],
      );
      if (
        Number(budget.rows[0]!.bytes) + Buffer.byteLength(input.text) >
          240000 ||
        Number(budget.rows[0]!.n) >= 98
      )
        throw new IdentityError(
          413,
          "cloud_context_full",
          "Start a new conversation to continue.",
        );
      const r = (
        await c.query<Row>(
          "INSERT INTO cloud_work_runs(id,conversation_id,organization_id,member_id,request_id,fingerprint,gateway_id,model_id,admitted_device_id,admitted_device_session_id,admitted_browser_session_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
          [
            randomUUID(),
            id,
            a.organizationId,
            a.memberId,
            input.requestId,
            fp,
            input.gatewayId,
            input.modelId,
            a.deviceId ?? null,
            a.sessionId ?? null,
            a.browserSessionId ?? null,
          ],
        )
      ).rows[0]!;
      const usageAdmission = await this.analytics.captureCloudAdmission(
        c,
        a.organizationId,
        a.memberId,
      );
      await c.query(
        "UPDATE cloud_work_runs SET usage_admission=$2 WHERE id=$1",
        [r.id, JSON.stringify(usageAdmission)],
      );
      await this.files.attached(c, a, id, input.attachmentIds ?? []);
      const messageId = randomUUID();
      await c.query(
        "INSERT INTO cloud_work_messages(id,conversation_id,run_id,role,text,attachment_ids,author_id,content_bytes) VALUES ($1,$2,$3,'user',$4,$5,$6,$7)",
        [
          messageId,
          id,
          r.id,
          sealText(c, "message", messageId, "text", input.text),
          JSON.stringify(input.attachmentIds ?? []),
          a.memberId,
          Buffer.byteLength(input.text),
        ],
      );
      await this.event(c, r, "run.queued", {});
      // The first admitted message names an untouched default conversation.
      // Revision also protects an explicit rename back to the default label.
      const title =
        conv.title === "New conversation" &&
        conv.revision === 1 &&
        Number(budget.rows[0]!.n) === 0
          ? input.text.trim().split(/\r\n|\r|\n/, 1)[0]!
              .replace(/\s+/g, " ").slice(0, 200)
              // Match the API's 200 UTF-16-unit bound without splitting emoji.
              .replace(/[\uD800-\uDBFF]$/, "") || conv.title
          : conv.title;
      const updated = (
        await c.query<Row>(
          "UPDATE cloud_work_conversations SET title=$2,revision=revision+1,updated_at=NOW() WHERE id=$1 RETURNING *",
          [id, sealText(c, "conversation", id, "title", title)],
        )
      ).rows[0]!;
      await recordAuditEvent(c, {
        action: "work.cloud.run.queued",
        actorUserId: a.userId,
        organizationId: a.organizationId,
        subjectType: "cloud_run",
        subjectId: r.id,
      });
      if (conv.project_id) await this.projects.invalidate(c, conv.project_id);
      return { conversation: conversation({ ...updated, title }), run: run(r) };
    });
  }
  async ownRun(c: PoolClient, a: CloudActor, id: string, lock = false) {
    const projectId = await this.projects.resource(c, a, "run", id);
    const r = await c.query<Row>(
      `SELECT r.*,(SELECT conv.personal_project_id FROM cloud_work_conversations conv WHERE conv.id=r.conversation_id) AS personal_project_id
       FROM cloud_work_runs r WHERE r.id=$1 AND r.organization_id=$2 AND (r.member_id=$3 OR r.project_id=$4) ${lock ? "FOR UPDATE OF r" : ""}`,
      [id, a.organizationId, a.memberId, projectId],
    );
    if (!r.rows[0])
      throw new IdentityError(
        404,
        "cloud_not_found",
        "Cloud run was not found.",
      );
    if (r.rows[0].personal_project_id) {
      // Runs of a deleted personal project are as gone as its chats.
      await this.personalProjects.authorization.bind(c, a);
      const live = await c.query(
        "SELECT 1 FROM cloud_work_personal_projects WHERE id=$1 AND organization_id=$2 AND member_id=$3 AND status<>'deleted'",
        [r.rows[0].personal_project_id, a.organizationId, a.memberId],
      );
      if (!live.rowCount) throw new IdentityError(404, "cloud_not_found", "Cloud run was not found.");
    }
    return this.decodeRun(c, r.rows[0]);
  }
  decodeRun(c: PoolClient, r: Row): Row { return { ...r, assistant_text: openText(c, "run", r.id, "assistant_text", r.assistant_text) }; }
  async snapshot(a: CloudActor, id: string) {
    return this.transaction(async (c) => {
      await this.ensure(c, a);
      const r = await this.ownRun(c, a, id);
      return {
        run: run(r),
        assistantText: r.assistant_text,
        ...(await this.tools.snapshotTx(c, [r.id])),
      };
    });
  }
  async cancel(a: CloudActor, id: string) {
    return this.transaction(async (c) => {
      await this.ensure(c, a);
      const r = await this.ownRun(c, a, id, true);
      if (r.project_id) await this.projects.authorize(c, a, r.project_id, r.member_id === a.memberId ? "chat" : "runs.manage");
      if (["queued", "running", "awaitingApproval"].includes(r.status))
        await this.terminal(c, r, "cancelled");
      return { run: run(r), assistantText: r.assistant_text };
    });
  }
  async events(a: CloudActor, id: string, after: number) {
    return this.transaction(async (c) => {
      await this.ensure(c, a);
      const r = await this.ownRun(c, a, id);
      if (after > r.last_sequence || r.last_sequence - after > 500)
        conflict("cloud_replay_gap");
      const rows = await c.query<{
        sequence: number;
        type: CloudEventType;
        data: CloudEvent["data"];
        created_at: Date;
      }>(
        "SELECT * FROM cloud_work_events WHERE run_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 16",
        [id, after],
      );
      return {
        run: run(r),
        events: (() => {
          let bytes = 0;
          const events: CloudEvent[] = [];
          for (const e of rows.rows) {
            const event = {
              sequence: e.sequence,
              type: e.type,
              data: openJson(c, "event", `${id}:${e.sequence}`, "data", e.data),
              createdAt: iso(e.created_at),
            };
            const size = Buffer.byteLength(JSON.stringify(event));
            if (bytes + size > 1048576 && events.length) break;
            bytes += size;
            events.push(event);
          }
          return events;
        })(),
      };
    });
  }
  async event(
    c: PoolClient,
    r: Row,
    type: CloudEventType,
    data: CloudEvent["data"],
    requestId?: string,
    fp?: string,
  ) {
    r.last_sequence++;
    await c.query(
      "INSERT INTO cloud_work_events(run_id,sequence,type,data,request_id,fingerprint) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        r.id,
        r.last_sequence,
        type,
        JSON.stringify(sealJson(c, "event", `${r.id}:${r.last_sequence}`, "data", data)),
        requestId ?? null,
        fp ?? null,
      ],
    );
    await c.query(
      "UPDATE cloud_work_runs SET last_sequence=$2,updated_at=NOW() WHERE id=$1",
      [r.id, r.last_sequence],
    );
  }
  async terminal(
    c: PoolClient,
    r: Row,
    status: CloudRun["status"],
    code?: string,
  ) {
    this.tools.cancelRun(r.id);
    r.status = status;
    r.error_code = code ?? null;
    r.updated_at = new Date();
    await c.query(
      "UPDATE cloud_work_runs SET status=$2,error_code=$3,lease_until=NULL,updated_at=NOW() WHERE id=$1",
      [r.id, status, code ?? null],
    );
    await c.query(
      "UPDATE cloud_work_approvals SET status='expired',decided_at=NOW() WHERE run_id=$1 AND status='pending'",
      [r.id],
    );
    await c.query(
      "UPDATE cloud_work_tool_invocations SET status=CASE WHEN status='running' THEN 'unknown' ELSE 'denied' END,updated_at=NOW() WHERE run_id=$1 AND status IN ('running','pendingApproval','pendingExecution')",
      [r.id],
    );
    await c.query(
      "DELETE FROM cloud_work_staged_files WHERE invocation_id IN (SELECT id FROM cloud_work_tool_invocations WHERE run_id=$1)",
      [r.id],
    );
    await this.event(
      c,
      r,
      `run.${status}` as CloudEventType,
      code ? { code } : {},
    );
    if (r.assistant_text || status === "completed") {
      const messageId = randomUUID();
      await c.query(
        "INSERT INTO cloud_work_messages(id,conversation_id,run_id,role,text,content_bytes) VALUES ($1,$2,$3,'assistant',$4,$5) ON CONFLICT(run_id,role) DO NOTHING",
        [messageId, r.conversation_id, r.id, sealText(c, "message", messageId, "text", r.assistant_text), Buffer.byteLength(r.assistant_text)],
      );
    }
    if (r.project_id) await this.projects.invalidate(c, r.project_id);
    await c.query(
      "UPDATE cloud_work_conversations SET revision=revision+1,updated_at=NOW() WHERE id=$1",
      [r.conversation_id],
    );
    await recordAuditEvent(c, {
      action: `work.cloud.run.${status}`,
      organizationId: r.organization_id,
      subjectType: "cloud_run",
      subjectId: r.id,
      metadata: code ? { code } : {},
    });
  }
  workerAuth(authorization?: string) {
    const secret = this.config.cloud?.workerSecret;
    if (
      !secret ||
      !authorization ||
      !secureEqual(authorization, `Bearer ${secret}`)
    )
      throw new IdentityError(
        401,
        "cloud_worker_unauthorized",
        "Worker authentication failed.",
      );
  }
  async claim(
    workerId: string,
    capabilities: Record<string, boolean> = {},
  ): Promise<CloudWorkerClaim | null> {
    return this.transaction(async (c) => {
      await c.query(
        "INSERT INTO cloud_work_workers(id,capabilities) VALUES ($1,$2) ON CONFLICT(id) DO UPDATE SET last_seen_at=NOW(),capabilities=EXCLUDED.capabilities",
        [workerId, JSON.stringify(capabilities)],
      );
      let candidate = (
        await c.query<Row>(
          // Fair share: the organization using the fewest workers goes first.
          "SELECT r.* FROM cloud_work_runs r JOIN cloud_work_settings s ON s.organization_id=r.organization_id AND s.enabled WHERE r.project_id IS NULL AND r.status='queued' ORDER BY (SELECT count(*) FROM cloud_work_runs busy WHERE busy.organization_id=r.organization_id AND busy.status IN ('running','awaitingApproval')), r.created_at LIMIT 1",
        )
      ).rows[0];
      if (capabilities.projectScopes === true && await this.projects.ready(c)) {
        const project = (await c.query<Row>("SELECT q.* FROM cloud_work_project_run_queue q JOIN cloud_work_settings s ON s.organization_id=q.organization_id AND s.enabled WHERE q.status='queued' ORDER BY q.created_at LIMIT 1")).rows[0];
        if (project && (!candidate || project.created_at < candidate.created_at)) candidate = project;
      }
      if (!candidate) return null;
      await c.query(
        "SELECT organization_id FROM organization_policies WHERE organization_id=$1 FOR SHARE",
        [candidate.organization_id],
      );
      await c.query(
        'SELECT id FROM member WHERE id=$1 AND "organizationId"=$2 FOR SHARE',
        [candidate.member_id, candidate.organization_id],
      );
      const settings = await c.query(
        "SELECT organization_id FROM cloud_work_settings WHERE organization_id=$1 AND enabled FOR SHARE",
        [candidate.organization_id],
      );
      if (!settings.rowCount) return null;
      await this.personalProjects.authorization.bind(c, { organizationId: candidate.organization_id, memberId: candidate.member_id });
      if (candidate.project_id) await this.projects.bindInternal(c, candidate.organization_id, candidate.project_id);
      const result = await c.query<Row>(
        "SELECT * FROM cloud_work_runs WHERE id=$1 AND status='queued' FOR UPDATE SKIP LOCKED",
        [candidate.id],
      );
      const r = result.rows[0] ? this.decodeRun(c, result.rows[0]) : undefined;
      if (!r) return null;
      const m = await c.query<{
        user_id: string;
      }>(
        'SELECT "userId" AS user_id FROM member WHERE id=$1 AND "organizationId"=$2',
        [r.member_id, r.organization_id],
      );
      if (!m.rows[0]) {
        await this.terminal(c, r, "cancelled", "membership_revoked");
        return null;
      }
      let target;
      let personalProject = false;
      try {
        await this.assertRunSession(c, r, m.rows[0]!.user_id);
        let projectPolicy;
        if (r.project_id) projectPolicy = (await this.projects.authorize(c, { organizationId: r.organization_id, memberId: r.member_id, userId: m.rows[0]!.user_id, role: "member" }, r.project_id, "chat")).row.policy;
        else {
          const owner = { organizationId: r.organization_id, memberId: r.member_id };
          const personalId = await this.personalProjects.context.projectIdTx(c, owner, r.conversation_id);
          if (personalId) {
            this.personalProjects.authorization.requireActive(await this.personalProjects.authorization.own(c, owner, personalId));
            personalProject = true;
          }
        }
        target = await this.providers.authorizeCloudRequest(
          r.organization_id,
          r.member_id,
          r.gateway_id,
          c,
          projectPolicy,
        );
        if (!target.allowedModels.includes(r.model_id)) throw Error();
      } catch {
        await this.terminal(c, r, "cancelled", "policy_revoked");
        return null;
      }
      r.lease_id = randomUUID();
      r.lease_version++;
      r.status = "running";
      await c.query(
        "UPDATE cloud_work_runs SET status='running',lease_id=$2,lease_version=$3,worker_id=$4,worker_capabilities=$5,lease_until=clock_timestamp()+INTERVAL '30 seconds',updated_at=NOW() WHERE id=$1",
        [
          r.id,
          r.lease_id,
          r.lease_version,
          workerId,
          JSON.stringify(capabilities),
        ],
      );
      await this.event(c, r, "run.started", {});
      const messages = await c.query<{
        id: string;
        role: "user" | "assistant";
        text: string;
      }>(
        // The newest messages, oldest first: a long conversation must keep its latest turns.
        "SELECT id,role,text FROM (SELECT role,text,created_at,id FROM cloud_work_messages WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100) latest ORDER BY created_at,id",
        [r.conversation_id],
      );
      const claims = {
        ...(r.project_id ? { projectId: r.project_id } : {}),
        runId: r.id,
        leaseId: r.lease_id,
        leaseVersion: r.lease_version,
        organizationId: r.organization_id,
        memberId: r.member_id,
      };
      // Budgets follow the model: a 1M-token model is no longer held to 16k.
      // The provider is asked before the first round (outside this transaction);
      // until then this is the published or family estimate.
      const limits = this.limits.peek(target.providerId, r.model_id, target);
      return {
        run: {
          id: r.id,
          conversationId: r.conversation_id,
          organizationId: r.organization_id,
          memberId: r.member_id,
          gatewayId: r.gateway_id,
          modelId: r.model_id,
          providerId: target.providerId,
          protocol: target.protocol,
          nativeOpenai: false,
          leaseId: r.lease_id,
          leaseVersion: r.lease_version,
          messages: messages.rows.map(m => ({ role: m.role, text: openText(c, "message", m.id, "text", m.text) })),
          // The worker's own check; each provider request carries the real budget.
          maxOutputTokens: Math.min(limits.outputTokens, MAX_RESPONSE_TOKENS),
          tools: await this.allowedDefinitions(
            c,
            r.organization_id,
            r.member_id,
            m.rows[0]!.user_id,
            capabilities.isolatedExecution === true,
            personalProject,
          ),
          contextTokenLimit: limits.contextTokens,
          maxRounds: MAX_ROUNDS,
        },
        leaseToken: signLease(this.config.cloud!.workerSecret, claims),
      };
    });
  }
  claims(authorization: string | undefined, id: string) {
    if (!this.config.cloud?.workerSecret)
      throw new IdentityError(
        401,
        "cloud_worker_unauthorized",
        "Worker authentication is not configured.",
      );
    const claims = readLease(this.config.cloud.workerSecret, authorization);
    if (claims.runId !== id) denied("cloud_worker_scope");
    return claims;
  }
  async lease(c: PoolClient, claims: LeaseClaims) {
    // Signed worker authority: the lease names the run's owner. The run query below must match all of it.
    await c.query("SELECT set_config('lori.organization_id',$1,true),set_config('lori.member_id',$2,true)", [claims.organizationId, claims.memberId]);
    const project = (await c.query<{ project_id: string }>("SELECT project_id FROM cloud_work_project_resource_scopes WHERE kind='run' AND resource_id=$1 AND organization_id=$2", [claims.runId, claims.organizationId])).rows[0];
    if (project) {
      if (claims.projectId !== project.project_id) denied("cloud_worker_scope");
      await this.projects.bindInternal(c, claims.organizationId, project.project_id);
    } else if (claims.projectId) denied("cloud_worker_scope");
    await c.query(
      "SELECT organization_id FROM organization_policies WHERE organization_id=$1 FOR SHARE",
      [claims.organizationId],
    );
    await c.query(
      'SELECT id FROM member WHERE id=$1 AND "organizationId"=$2 FOR SHARE',
      [claims.memberId, claims.organizationId],
    );
    await c.query(
      "SELECT organization_id FROM cloud_work_settings WHERE organization_id=$1 FOR SHARE",
      [claims.organizationId],
    );
    const result = await c.query<Row>(
      "SELECT * FROM cloud_work_runs WHERE id=$1 AND organization_id=$2 AND member_id=$3 AND lease_id=$4 AND lease_version=$5 AND status IN ('running','awaitingApproval') AND lease_until>clock_timestamp() FOR UPDATE",
      [
        claims.runId,
        claims.organizationId,
        claims.memberId,
        claims.leaseId,
        claims.leaseVersion,
      ],
    );
    const r = result.rows[0] ? this.decodeRun(c, result.rows[0]) : undefined;
    if (!r) conflict("cloud_lease_expired");
    const m = await c.query<{
      user_id: string;
    }>(
      'SELECT "userId" AS user_id FROM member WHERE id=$1 AND "organizationId"=$2',
      [r.member_id, r.organization_id],
    );
    if (!m.rows[0]) denied();
    const s = await c.query(
      "SELECT 1 FROM cloud_work_settings WHERE organization_id=$1 AND enabled",
      [r.organization_id],
    );
    if (!s.rowCount) denied("cloud_disabled");
    await this.assertRunSession(c, r, m.rows[0]!.user_id);
    const projectRow = r.project_id
      ? (await this.projects.authorize(c, { organizationId: r.organization_id, memberId: r.member_id, userId: m.rows[0]!.user_id, role: "member" }, r.project_id, "chat")).row
      : undefined;
    const target = await this.providers.authorizeCloudRequest(
      r.organization_id,
      r.member_id,
      r.gateway_id,
      c,
      projectRow?.policy,
    );
    if (!target.allowedModels.includes(r.model_id))
      denied("cloud_model_denied");
    return { r, target };
  }
  async assertRunSession(c: PoolClient, r: Row, userId: string) {
    if (r.admitted_browser_session_id)
      await this.assertSession(c, {
        organizationId: r.organization_id,
        memberId: r.member_id,
        userId,
        role: "member",
        browserSessionId: r.admitted_browser_session_id,
      });
    if (r.admitted_device_id) {
      const valid = await c.query(
        "SELECT 1 FROM devices d JOIN device_sessions s ON s.device_id=d.id WHERE d.id=$1 AND d.organization_id=$2 AND d.user_id=$3 AND d.revoked_at IS NULL AND s.id=$4 AND s.revoked_at IS NULL AND s.access_expires_at>NOW() FOR SHARE OF d,s",
        [
          r.admitted_device_id,
          r.organization_id,
          userId,
          r.admitted_device_session_id,
        ],
      );
      if (!valid.rowCount) denied("cloud_session_revoked");
    }
  }
  async heartbeat(claims: LeaseClaims) {
    return this.transaction(async (c) => {
      const { r } = await this.lease(c, claims);
      await c.query(
        "UPDATE cloud_work_runs SET lease_until=clock_timestamp()+INTERVAL '30 seconds' WHERE id=$1",
        [r.id],
      );
      await c.query(
        "UPDATE cloud_work_workers SET last_seen_at=NOW() WHERE id=$1",
        [r.worker_id],
      );
      return { cancelRequested: false };
    });
  }
  async delta(claims: LeaseClaims, requestId: string, text: string) {
    return this.transaction(async (c) => {
      const { r } = await this.lease(c, claims);
      const fp = fingerprint(text);
      const old = await c.query<{
        sequence: number;
        fingerprint: string;
      }>(
        "SELECT sequence,fingerprint FROM cloud_work_events WHERE run_id=$1 AND request_id=$2",
        [r.id, requestId],
      );
      if (old.rows[0]) {
        if (old.rows[0].fingerprint !== fp)
          conflict("cloud_idempotency_conflict");
        return { sequence: old.rows[0].sequence };
      }
      if (
        r.last_sequence >= 10000 ||
        Buffer.byteLength(r.assistant_text + text) > 1048576
      )
        throw new IdentityError(
          413,
          "cloud_output_full",
          "Cloud output limit reached.",
        );
      await c.query(
        "UPDATE cloud_work_runs SET assistant_text=$2 WHERE id=$1",
        [r.id, sealText(c, "run", r.id, "assistant_text", r.assistant_text + text)],
      );
      await this.event(c, r, "assistant.delta", { text }, requestId, fp);
      return { sequence: r.last_sequence };
    });
  }
  async complete(
    claims: LeaseClaims,
    input: {
      text: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
      };
      finishReason?: string;
    },
  ) {
    return this.transaction(async (c) => {
      const { r } = await this.lease(c, claims);
      await this.rounds.completedTx(c, r.id);
      if (r.assistant_text !== input.text) conflict("cloud_output_mismatch");
      await c.query(
        "UPDATE cloud_work_runs SET usage=$2,finish_reason=$3 WHERE id=$1",
        [
          r.id,
          input.usage ? JSON.stringify(input.usage) : null,
          input.finishReason ?? null,
        ],
      );
      await this.terminal(c, r, "completed");
      return { run: run(r), assistantText: r.assistant_text };
    });
  }
  async fail(
    claims: LeaseClaims,
    input: {
      usage?: {
        inputTokens: number;
        outputTokens: number;
      };
      finishReason?: string;
    } = {},
  ) {
    return this.transaction(async (c) => {
      const { r } = await this.lease(c, claims);
      await c.query(
        "UPDATE cloud_work_runs SET usage=$2,finish_reason=COALESCE($3,finish_reason) WHERE id=$1",
        [
          r.id,
          input.usage ? JSON.stringify(input.usage) : null,
          input.finishReason ?? null,
        ],
      );
      // A recorded provider failure is the real reason; the worker only knows it was refused.
      const cause =
        PROVIDER_FAILURES.find((item) => item === r.finish_reason) ??
        (input.finishReason === "model_tool_call_invalid"
          ? input.finishReason
          : undefined);
      await this.terminal(c, r, "failed", cause ?? "worker_failed");
      return { run: run(r), assistantText: r.assistant_text };
    });
  }
  /** Records the category of an upstream provider failure on the run, once. */
  async recordProviderFailure(runId: string, cause: ProviderFailure) {
    const scope = (await this.pool.query<{ organization_id: string; project_id: string }>("SELECT organization_id,project_id FROM cloud_work_project_run_queue WHERE id=$1", [runId])).rows[0];
    await this.transaction(async c => {
      if (scope) await this.projects.bindInternal(c, scope.organization_id, scope.project_id);
      await c.query(
      "UPDATE cloud_work_runs SET finish_reason=$2 WHERE id=$1 AND status IN ('running','awaitingApproval') AND finish_reason IS NULL",
      [runId, cause],
      );
    });
  }
  async provider(claims: LeaseClaims, start = false) {
    return this.transaction(async (c) => {
      const { r, target } = await this.lease(c, claims);
      if (start) {
        if (r.provider_started) conflict("cloud_provider_already_started");
        await c.query(
          "UPDATE cloud_work_runs SET provider_started=TRUE WHERE id=$1",
          [r.id],
        );
      }
      return { run: r, target };
    });
  }
  /**
   * Work policy (Manage Work Access) is the single switch for Cloud Work, so
   * disabling Work, a provider, or a model must also stop work already in
   * flight. Only definitive authorization denials cancel a run; transient
   * failures leave it for the next sweep.
   */
  async revokeDeniedRuns() {
    type Candidate = Pick<
      Row,
      "id" | "organization_id" | "member_id" | "gateway_id" | "model_id"
    >;
    // True only for a definitive denial. Anything else (a transient failure,
    // a key that cannot be decrypted) leaves the run alone for a later sweep.
    const verdict = async (
      r: Candidate,
      database: Pool | PoolClient,
    ): Promise<boolean | null> => {
      try {
        const target = await this.providers.authorizeCloudRequest(
          r.organization_id,
          r.member_id,
          r.gateway_id,
          database,
        );
        return !target.allowedModels.includes(r.model_id);
      } catch (failure) {
        return failure instanceof IdentityError && failure.statusCode === 403
          ? true
          : null;
      }
    };
    // Decide without holding row locks: authorization takes several queries and
    // a key decryption, and workers need these rows to heartbeat and stream.
    const active = await this.pool.query<Candidate>(
      // Random order so a backlog beyond one batch is still covered over successive sweeps.
      // Private runs only: shared-project runs are rechecked with their project's policy in projects.maintain().
      "SELECT id,organization_id,member_id,gateway_id,model_id FROM cloud_work_runs WHERE project_id IS NULL AND status IN ('queued','running','awaitingApproval') ORDER BY random() LIMIT 100",
    );
    const denied: Candidate[] = [];
    const seen = new Map<string, boolean | null>();
    for (const r of active.rows) {
      const key = `${r.organization_id}|${r.member_id}|${r.gateway_id}|${r.model_id}`;
      if (!seen.has(key)) seen.set(key, await verdict(r, this.pool));
      if (seen.get(key) === true) denied.push(r);
    }
    for (const candidate of denied) {
      // Lock only to cancel, one run at a time, and re-confirm under the lock.
      await this.transaction(async (c) => {
        const found = await c.query<Row>(
          "SELECT * FROM cloud_work_runs WHERE id=$1 AND project_id IS NULL AND status IN ('queued','running','awaitingApproval') FOR UPDATE SKIP LOCKED",
          [candidate.id],
        );
        const r = found.rows[0];
        if (r && (await verdict(r, c)) === true)
          await this.terminal(c, r, "cancelled", "policy_revoked");
      });
    }
  }
  /**
   * An approval nobody answers must not hold a run, and the worker serving it,
   * forever. After the timeout it is recorded as expired and the action as not
   * run, so the model can tell the member what happened and carry on.
   */
  async expireStaleApprovals(timeoutMinutes: number, scope?: { organization_id: string; project_id: string }) {
    const stale = await this.transaction(async c => {
      if (scope) await this.projects.bindInternal(c, scope.organization_id, scope.project_id);
      return c.query<{ id: string; run_id: string }>(
        "SELECT a.id,a.run_id FROM cloud_work_approvals a JOIN cloud_work_runs r ON r.id=a.run_id WHERE r.project_id IS NOT DISTINCT FROM $2::uuid AND a.status='pending' AND r.status='awaitingApproval' AND a.created_at<NOW()-make_interval(mins=>$1) ORDER BY a.created_at LIMIT 50", [timeoutMinutes, scope?.project_id ?? null]);
    });
    for (const item of stale.rows) {
      await this.transaction(async (c) => {
        if (scope) await this.projects.bindInternal(c, scope.organization_id, scope.project_id);
        const run = (
          await c.query<Row>(
            "SELECT * FROM cloud_work_runs WHERE id=$1 AND status='awaitingApproval' FOR UPDATE SKIP LOCKED",
            [item.run_id],
          )
        ).rows[0];
        if (!run) return;
        const pending = (
          await readContent(c, "approval", c.query(
            "SELECT * FROM cloud_work_approvals WHERE id=$1 AND status='pending' FOR UPDATE",
            [item.id],
          ))
        ).rows[0];
        if (!pending) return;
        const output = {
          error: "approval_expired",
          message: "Approval was not given in time, so this action was not run.",
        };
        const expired = (
          await readContent(c, "approval", c.query(
            "UPDATE cloud_work_approvals SET status='expired',decided_at=NOW() WHERE id=$1 RETURNING *",
            [item.id],
          ))
        ).rows[0]!;
        const tool = (
          await readContent(c, "tool", c.query(
            "UPDATE cloud_work_tool_invocations SET status='denied',output=$2,model_output=$3,updated_at=NOW() WHERE id=$1 RETURNING *",
            [pending.invocation_id, JSON.stringify(sealJson(c, "tool", pending.invocation_id, "output", output)), JSON.stringify(sealJson(c, "tool", pending.invocation_id, "model_output", output))],
          ))
        ).rows[0]!;
        await c.query(
          "DELETE FROM cloud_work_staged_files WHERE invocation_id=$1",
          [tool.id],
        );
        const remaining = await c.query(
          "SELECT 1 FROM cloud_work_approvals WHERE run_id=$1 AND status='pending' LIMIT 1",
          [run.id],
        );
        if (!remaining.rowCount)
          await c.query(
            "UPDATE cloud_work_runs SET status='running' WHERE id=$1 AND status='awaitingApproval'",
            [run.id],
          );
        await this.event(c, run, "approval.decided", {
          approval: approval(expired),
          invocation: invocation(tool),
        });
      });
    }
  }
  async maintain() {
    await this.projects.maintain();
    // Commit interruption recovery before taking conversation locks for retention.
    await this.transaction(async (c) => {
      const expired = await c.query<Row>(
        "SELECT * FROM cloud_work_runs WHERE (status IN ('running','awaitingApproval') AND lease_until<clock_timestamp()) OR (status='queued' AND created_at<NOW()-INTERVAL '15 minutes') FOR UPDATE SKIP LOCKED LIMIT 100",
      );
      for (const r of expired.rows)
        await this.terminal(c, r, "interrupted", "worker_lease_expired");
    });
    await this.revokeDeniedRuns();
    await this.expireStaleApprovals(
      this.config.cloud?.approvalTimeoutMinutes ?? 15,
    );
    await this.files.cleanup();
    await this.personalProjects.maintain();
    // Derived embeddings never block maintenance; failures leave memory lexical.
    await this.memory.indexPending().catch(() => undefined);
    await this.transaction(async (c) => {
      await c.query(
        "DELETE FROM cloud_work_workers WHERE last_seen_at<NOW()-INTERVAL '1 day'",
      );
      // Scoped internal read: chats of a deleted personal project wait out its recovery window.
      await c.query("SELECT set_config('lori.personal_scope','internal',true)");
      await c.query(
        "DELETE FROM cloud_work_conversations WHERE id IN (SELECT conv.id FROM cloud_work_conversations conv JOIN cloud_work_settings settings ON conv.organization_id=settings.organization_id WHERE conv.updated_at<NOW()-make_interval(days=>settings.retention_days) AND NOT EXISTS(SELECT 1 FROM cloud_work_runs r WHERE r.conversation_id=conv.id AND r.status IN ('queued','running','awaitingApproval')) AND (conv.personal_project_id IS NULL OR NOT EXISTS(SELECT 1 FROM cloud_work_personal_projects pp WHERE pp.id=conv.personal_project_id AND pp.status='deleted')) ORDER BY conv.updated_at LIMIT 100 FOR UPDATE OF conv SKIP LOCKED)",
      );
    });
    // Last: a slow provider must not delay recovery. A failure keeps the last good
    // list and reaches the maintenance log.
    await this.providers.syncDueWorkModels();
  }
}
