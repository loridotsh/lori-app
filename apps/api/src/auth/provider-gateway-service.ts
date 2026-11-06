import { WorkPricingSchema, type WorkPricing } from "../cloud/pricing.js";
import {
  discoverWorkModels,
  listingKeyAccepted,
  MODEL_SYNC_PROVIDERS,
  supportsModelSync,
  syncableModelIds,
  type WorkDiscoveredModel,
} from "./work-model-discovery.js";
import type { LimitTarget } from "../cloud/model-limit-discovery.js";
import { WORK_GATEWAY_PROVIDER_IDS } from "./work-catalog.js";
import type { WorkService } from "./work-service.js";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  WorkProviderGateway,
  WorkProviderGatewaysResponse,
  CreateWorkProviderGatewayInput,
  UpdateWorkProviderGatewayInput,
  ManagedProviderCredential,
  ManagedProviderCredentialsResponse,
  ManagedProviderGateway,
  OrganizationProviderGatewayCatalogResponse,
  OrganizationProviderGateway,
  OrganizationProviderGatewaysResponse,
  PolicyCatalogItemType,
  ProjectPolicy,
  Role,
} from "@lori-enterprise/contracts";
import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../config.js";
import {
  providerGatewayDefinition,
  providerGatewayDefinitions,
  type ProviderGatewayDefinition,
  type ProviderGatewayRoute,
} from "../catalog.js";
import { recordAuditEvent } from "./audit.js";
import type { LoriAuth } from "./auth.js";
import type { EnrollmentService } from "./enrollment-service.js";
import { IdentityError } from "./identity-service.js";
import {
  activeOrganizationSql,
  isOrganizationAdministrator,
  parseOrganizationRole,
} from "./authority.js";

const GATEWAY_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;
const MODEL_PATTERN = /^[^\u0000-\u001F\u007F]{1,160}$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface BrowserSession {
  session?: { activeOrganizationId?: string | null };
  user: { id: string };
}

interface AdminRow {
  organization_id: string;
  role: Role;
  user_id: string;
}

interface GatewayRow {
  work_model_pricing?: Record<string, WorkPricing>;
  work_model_sync?: boolean;
  work_synced_models?: unknown;
  created_at: Date;
  enabled_models: unknown;
  encrypted_api_key: string;
  id: string;
  organization_id: string;
  provider_id: string;
  requests_per_minute: number;
  updated_at: Date;
}

interface GatewayClaims {
  p?: "work";
  s?: string;
  d: string;
  e: number;
  g: string;
  v: 1;
}

interface GatewayAccessRow extends GatewayRow {
  device_id: string;
  member_id: string;
  user_id: string;
}

export interface CreateOrganizationProviderGatewayInput {
  apiKey: string;
  enabledModels: string[];
  expectedRevision: number;
  providerId: string;
  requestsPerMinute: number;
}

export interface UpdateOrganizationProviderGatewayInput {
  apiKey?: string;
  enabledModels?: string[];
  expectedRevision: number;
  requestsPerMinute?: number;
}

export interface AuthorizedProviderGatewayRequest {
  organizationId: string;
  allowedModels: string[];
  apiKey: string;
  deviceId: string;
  gatewayId: string;
  providerId: string;
  requestsPerMinute: number;
  upstreamBaseUrl: string;
  workModelPricing?: Record<string, WorkPricing>;
}

const requireRole: (value: string) => Role = parseOrganizationRole;

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return null;
  }
}

function normalizedModels(models: string[]): string[] {
  const unique = new Set<string>();
  for (const input of models) {
    const model = input.trim();
    if (!MODEL_PATTERN.test(model)) {
      throw new IdentityError(
        400,
        "invalid_provider_model",
        "Each allowed model must be a non-empty model identifier.",
      );
    }
    unique.add(model);
  }
  const result = [...unique];
  if (result.length === 0 || result.length > 32) {
    throw new IdentityError(
      400,
      "invalid_provider_models",
      "Choose between one and 32 allowed models.",
    );
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function modelsFromDatabase(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Organization provider models are stored incorrectly");
  }
  if (!value.every((item): item is string => typeof item === "string")) {
    throw new Error("Organization provider models are stored incorrectly");
  }
  return value.length === 0 ? [] : normalizedModels(value);
}

/** A server-written list, so it is not bound by the 32 an administrator can assign by hand. */
export function syncedModelIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function supportedGatewayProvider(
  providerId: string,
  source: "input" | "stored",
): ProviderGatewayDefinition {
  try {
    return providerGatewayDefinition(providerId);
  } catch {
    if (source === "input") {
      throw new IdentityError(
        400,
        "invalid_provider",
        "Choose a supported cloud provider.",
      );
    }
    throw new IdentityError(
      409,
      "provider_gateway_unsupported",
      "This organization provider is no longer supported. An administrator must disconnect or replace it.",
    );
  }
}

function modelGatewayUrl(
  publicUrl: string,
  gatewayId: string,
  route: ProviderGatewayRoute,
): string {
  const encodedId = encodeURIComponent(gatewayId);
  return route === "openai"
    ? `${publicUrl}/api/v1/gateway/providers/${encodedId}/openai/v1`
    : `${publicUrl}/api/v1/gateway/providers/${encodedId}/anthropic`;
}

function desktopGatewayContract(
  row: GatewayRow,
  config: AppConfig,
): ManagedProviderGateway {
  const provider = supportedGatewayProvider(row.provider_id, "stored");
  const routeBaseUrls = Object.fromEntries(
    Object.keys(provider.routes).map((route) => [
      route,
      modelGatewayUrl(config.publicUrl, row.id, route as ProviderGatewayRoute),
    ]),
  ) as ManagedProviderGateway["routeBaseUrls"];
  const primaryRoute = provider.routes[provider.kind]
    ? provider.kind
    : (Object.keys(provider.routes)[0] as ProviderGatewayRoute | undefined);
  if (!primaryRoute || !routeBaseUrls[primaryRoute]) {
    throw new Error(
      `Provider ${row.provider_id} does not expose a supported gateway route`,
    );
  }
  return {
    enabledModels: modelsFromDatabase(row.enabled_models),
    gatewayId: row.id,
    kind: provider.kind,
    name: provider.name,
    providerId: provider.id,
    routeBaseUrls,
    supportedAgents: provider.supportedAgents,
  };
}

function organizationGatewayContract(
  row: GatewayRow,
  policyRevision: number,
): OrganizationProviderGateway {
  const provider = supportedGatewayProvider(row.provider_id, "stored");
  return {
    createdAt: row.created_at.toISOString(),
    credentialConfigured: true,
    enabledModels: modelsFromDatabase(row.enabled_models),
    id: row.id,
    policyRevision,
    providerId: provider.id,
    providerKind: provider.kind,
    providerName: provider.name,
    requestsPerMinute: row.requests_per_minute,
    updatedAt: row.updated_at.toISOString(),
  };
}

function workGatewayContract(
  row: GatewayRow,
  revision: number,
): WorkProviderGateway {
  const provider = supportedGatewayProvider(row.provider_id, "stored");
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: provider.name,
    credentialConfigured: true,
    requestsPerMinute: row.requests_per_minute,
    policyRevision: revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(supportsModelSync(row.provider_id)
      ? {
          modelSync: {
            enabled: row.work_model_sync === true,
            modelIds: syncedModelIds(row.work_synced_models),
          },
        }
      : {}),
  };
}
function assertWorkGatewayProvider(providerId: string): void {
  if (!WORK_GATEWAY_PROVIDER_IDS.some((id) => id === providerId)) {
    throw new IdentityError(
      400,
      "invalid_work_provider",
      "Choose a supported Work company provider.",
    );
  }
}
function validateGatewayRate(rate: number): void {
  if (!Number.isInteger(rate) || rate < 1 || rate > 600) {
    throw new IdentityError(
      400,
      "invalid_provider_rate_limit",
      "Provider requests per minute must be between 1 and 600.",
    );
  }
}

function normalizeApiKey(value: string): string {
  const key = value.trim();
  if (
    key.length === 0 ||
    key.length > 8_192 ||
    /[\u0000-\u001F\u007F]/.test(key)
  ) {
    throw new IdentityError(
      400,
      "invalid_provider_credential",
      "Enter a valid provider API key.",
    );
  }
  return key;
}

function providerEnabled(
  policy: {
    managedCatalog: Array<{
      enabled: boolean;
      id: string;
      type: PolicyCatalogItemType;
    }>;
  },
  providerId: string,
): boolean {
  return policy.managedCatalog.some(
    (item) =>
      item.type === "provider" && item.id === providerId && item.enabled,
  );
}

export class ProviderGatewayService {
  public constructor(
    private readonly pool: Pool,
    private readonly auth: LoriAuth,
    private readonly config: AppConfig,
    private readonly enrollment: EnrollmentService,
    private readonly work?: WorkService,
  ) {}

  /** Trusted Cloud broker only: no device token or credential leaves the API. */
  public async authorizeCloudRequest(
    organizationId: string, memberId: string, gatewayId: string,
    database: Pool | PoolClient = this.pool,
    /** The shared project's policy when the request is scoped to one; never for private chats. */
    project?: ProjectPolicy,
  ): Promise<Omit<AuthorizedProviderGatewayRequest, "deviceId"> & { protocol: "openai" | "anthropic" }> {
    const result = await database.query<GatewayRow>(
      `SELECT gateways.* FROM organization_provider_gateways gateways
       JOIN member ON member.id=$2 AND member."organizationId"=gateways.organization_id
       WHERE gateways.id=$1 AND gateways.organization_id=$3`,
      [gatewayId, memberId, organizationId],
    );
    const row = result.rows[0];
    if (!row || !this.work) throw new IdentityError(403, "cloud_provider_denied", "Company provider access is unavailable.");
    const scope = await this.work.resourceScope(organizationId, memberId, database, project);
    if (!scope.policy.enabled)
      throw new IdentityError(403, "cloud_provider_denied", "Work is not enabled for your account.");
    const allowedModels = scope.models(row.provider_id);
    if (!allowedModels.length)
      throw new IdentityError(
        403,
        "cloud_provider_denied",
        project
          ? "This company provider has no models available in this project."
          : "Company provider access is disabled.",
      );
    const definition = supportedGatewayProvider(row.provider_id, "stored");
    const route = definition.routes[definition.kind];
    if (!route) throw new IdentityError(403, "cloud_provider_denied", "Company provider protocol is unavailable.");
    return {
      organizationId, gatewayId: row.id, providerId: row.provider_id,
      allowedModels,
      apiKey: this.decryptApiKey(row.encrypted_api_key, organizationId, row.provider_id),
      requestsPerMinute: row.requests_per_minute,
      upstreamBaseUrl: route.upstreamBaseUrl, protocol: definition.kind, workModelPricing: row.work_model_pricing,
    };
  }

  /** The credential-scoped identity the model-limit cache uses, without policy checks. */
  public limitTarget(organizationId: string, providerId: string, encryptedApiKey: string): LimitTarget | null {
    try {
      const definition = supportedGatewayProvider(providerId, "stored");
      const route = definition.routes[definition.kind];
      if (!route) return null;
      return { providerId, protocol: definition.kind, upstreamBaseUrl: route.upstreamBaseUrl,
        apiKey: this.decryptApiKey(encryptedApiKey, organizationId, providerId) };
    } catch {
      return null;
    }
  }

  private encryptionKey(): Buffer {
    return createHash("sha256")
      .update("lori-enterprise:provider-gateway:encryption\0", "utf8")
      .update(this.config.gateway.secret, "utf8")
      .digest();
  }

  private credentialContext(
    organizationId: string,
    providerId: string,
  ): Buffer {
    return Buffer.from(
      `lori-enterprise:provider-gateway:credential\0${organizationId}\0${providerId}`,
      "utf8",
    );
  }

  private encryptApiKey(
    apiKey: string,
    organizationId: string,
    providerId: string,
  ): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey(), iv);
    cipher.setAAD(this.credentialContext(organizationId, providerId));
    const ciphertext = Buffer.concat([
      cipher.update(apiKey, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `v2.${base64Url(iv)}.${base64Url(tag)}.${base64Url(ciphertext)}`;
  }

  private decryptApiKey(
    value: string,
    organizationId: string,
    providerId: string,
  ): string {
    const parts = value.split(".");
    const [version, encodedIv, encodedTag, encodedCiphertext] = parts;
    if (
      parts.length !== 4 ||
      (version !== "v1" && version !== "v2") ||
      !encodedIv ||
      !encodedTag ||
      !encodedCiphertext
    ) {
      throw new Error("Organization provider credential cannot be decrypted");
    }
    const iv = decodeBase64Url(encodedIv);
    const tag = decodeBase64Url(encodedTag);
    const ciphertext = decodeBase64Url(encodedCiphertext);
    if (!iv || !tag || !ciphertext || iv.length !== 12 || tag.length !== 16) {
      throw new Error("Organization provider credential cannot be decrypted");
    }
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.encryptionKey(),
        iv,
      );
      // v1 was used only by the initial unreleased implementation. Retain
      // read compatibility so a safe rollout fails neither silently nor
      // destructively; all new and rotated credentials are v2 and bound to
      // their organization/provider identity as authenticated data.
      if (version === "v2") {
        decipher.setAAD(this.credentialContext(organizationId, providerId));
      }
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      try {
        return plaintext.toString("utf8");
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw new Error("Organization provider credential cannot be decrypted");
    }
  }

  private signTokenPayload(payload: string): string {
    return createHmac("sha256", this.config.gateway.secret)
      .update(`lori-enterprise:provider-gateway:token\0${payload}`, "utf8")
      .digest("base64url");
  }

  private issueGatewayToken(
    deviceId: string,
    gatewayId: string,
    sessionId?: string,
  ): ManagedProviderCredential {
    const expiresAt = new Date(
      Date.now() + GATEWAY_TOKEN_LIFETIME_SECONDS * 1_000,
    );
    const payload: GatewayClaims = {
      ...(sessionId ? { p: "work" as const, s: sessionId } : {}),
      d: deviceId,
      e: Math.floor(expiresAt.getTime() / 1_000),
      g: gatewayId,
      v: 1,
    };
    const encoded = base64Url(Buffer.from(JSON.stringify(payload), "utf8"));
    return {
      expiresAt: expiresAt.toISOString(),
      gatewayId,
      token: `lpg1.${encoded}.${this.signTokenPayload(encoded)}`,
    };
  }

  private readGatewayToken(authorization: string | undefined): GatewayClaims {
    const match =
      /^Bearer lpg1\.([A-Za-z0-9_-]{16,512})\.([A-Za-z0-9_-]{32,128})$/i.exec(
        authorization?.trim() ?? "",
      );
    if (!match) {
      throw new IdentityError(
        401,
        "provider_gateway_authentication_required",
        "A valid organization provider credential is required.",
      );
    }
    const [, encodedPayload, encodedSignature] = match;
    if (!encodedPayload || !encodedSignature) {
      throw new IdentityError(
        401,
        "provider_gateway_token_invalid",
        "The organization provider credential is invalid.",
      );
    }
    const expected = Buffer.from(
      this.signTokenPayload(encodedPayload),
      "base64url",
    );
    const actual = Buffer.from(encodedSignature, "base64url");
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new IdentityError(
        401,
        "provider_gateway_token_invalid",
        "The organization provider credential is invalid.",
      );
    }
    const payloadBytes = decodeBase64Url(encodedPayload);
    let claims: unknown;
    try {
      claims = JSON.parse(payloadBytes?.toString("utf8") ?? "");
    } catch {
      claims = null;
    }
    if (
      !claims ||
      typeof claims !== "object" ||
      (claims as GatewayClaims).v !== 1 ||
      typeof (claims as GatewayClaims).d !== "string" ||
      typeof (claims as GatewayClaims).g !== "string" ||
      !Number.isSafeInteger((claims as GatewayClaims).e) ||
      (claims as GatewayClaims).e * 1_000 <= Date.now()
    ) {
      throw new IdentityError(
        401,
        "provider_gateway_token_expired",
        "The organization provider credential has expired. Refresh access in Lori.",
      );
    }
    return claims as GatewayClaims;
  }

  private async browserAdmin(
    headers: IncomingHttpHeaders,
    database: Pool | PoolClient = this.pool,
  ): Promise<AdminRow> {
    const session = (await this.auth.api.getSession({
      headers: fromNodeHeaders(headers),
    })) as BrowserSession | null;
    if (!session) {
      throw new IdentityError(401, "unauthenticated", "Sign in is required.");
    }
    const result = await database.query<AdminRow>(
      `
        SELECT
          members."organizationId" AS organization_id,
          members.role,
          users.id AS user_id
        FROM "user" users
        JOIN member members ON members."userId" = users.id
        WHERE users.id = $1
          AND members."organizationId" = ${activeOrganizationSql("$1", "$2")}
        LIMIT 1
      `,
      [session.user.id, session.session?.activeOrganizationId ?? null],
    );
    const actor = result.rows[0];
    const role = actor ? requireRole(actor.role) : undefined;
    if (!actor || !role || !isOrganizationAdministrator(role)) {
      throw new IdentityError(
        403,
        "admin_required",
        "Administrator access is required.",
      );
    }
    return { ...actor, role };
  }

  private async organizationRevision(
    database: Pool | PoolClient,
    organizationId: string,
  ): Promise<number> {
    const result = await database.query<{ revision: string }>(
      `SELECT revision::text FROM organization_policies WHERE organization_id = $1`,
      [organizationId],
    );
    const revision = result.rows[0];
    if (!revision) {
      throw new IdentityError(
        503,
        "policy_unavailable",
        "Organization policy has not been initialized.",
      );
    }
    return Number(revision.revision);
  }

  private async bumpPolicyRevision(
    client: PoolClient,
    organizationId: string,
    expectedRevision: number,
    actorUserId: string,
  ): Promise<number> {
    const result = await client.query<{ revision: string }>(
      `
        UPDATE organization_policies
        SET revision = revision + 1, updated_at = NOW(), updated_by_user_id = $3
        WHERE organization_id = $1 AND revision = $2
        RETURNING revision::text
      `,
      [organizationId, expectedRevision, actorUserId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new IdentityError(
        409,
        "policy_revision_conflict",
        "Access settings changed while this page was open. Reload and try again.",
      );
    }
    return Number(row.revision);
  }

  private async gatewayRow(
    database: Pool | PoolClient,
    organizationId: string,
    gatewayId: string,
  ): Promise<GatewayRow> {
    const result = await database.query<GatewayRow>(
      `
        SELECT
          id,
          organization_id,
          provider_id,
          encrypted_api_key,
          enabled_models,
          work_model_pricing,
          work_model_sync,
          work_synced_models,
          requests_per_minute,
          created_at,
          updated_at
        FROM organization_provider_gateways
        WHERE id = $1 AND organization_id = $2
        LIMIT 1
      `,
      [gatewayId, organizationId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new IdentityError(
        404,
        "provider_gateway_not_found",
        "The organization provider connection was not found.",
      );
    }
    return row;
  }

  public async workGatewayPricing(headers: IncomingHttpHeaders, gatewayId: string) {
    const actor = await this.browserAdmin(headers);
    // One MVCC snapshot keeps prices and the optimistic-lock revision consistent.
    const result = await this.pool.query<{ pricing: Record<string, WorkPricing>; revision: string }>(
      "SELECT g.work_model_pricing AS pricing,p.revision::text FROM organization_provider_gateways g JOIN organization_policies p ON p.organization_id=g.organization_id WHERE g.id=$1 AND g.organization_id=$2",
      [gatewayId, actor.organization_id],
    );
    const row = result.rows[0];
    if (!row) throw new IdentityError(404, "provider_gateway_not_found", "The organization provider connection was not found.");
    return { pricing: row.pricing, revision: Number(row.revision) };
  }
  public async saveWorkGatewayPricing(headers: IncomingHttpHeaders, gatewayId: string, modelId: string, pricing: WorkPricing | null, expectedRevision: number) {
    const model = normalizedModels([modelId])[0]!;
    const value = pricing === null ? null : WorkPricingSchema.parse({ ...pricing, source: "configured", version: new Date().toISOString() });
    return this.workGatewayMutation(headers, expectedRevision, async (client, actor, revision) => {
      const row = await this.gatewayRow(client, actor.organization_id, gatewayId);
      const rates: Record<string, WorkPricing> = Object.assign(Object.create(null), row.work_model_pricing ?? {});
      if (value) rates[model] = value; else delete rates[model];
      if (Object.keys(rates).length > 128) throw new IdentityError(400, "too_many_prices", "Configure no more than 128 model prices per provider.");
      await client.query("UPDATE organization_provider_gateways SET work_model_pricing=$3::jsonb,updated_at=NOW(),updated_by_user_id=$4 WHERE id=$1 AND organization_id=$2", [gatewayId, actor.organization_id, JSON.stringify(rates), actor.user_id]);
      await recordAuditEvent(client, { action: "work.provider_pricing_updated", actorUserId: actor.user_id, organizationId: actor.organization_id, subjectType: "provider", subjectId: gatewayId, metadata: { modelId: model, configured: value !== null } });
      return { pricing: rates, revision };
    });
  }

  /**
   * Keeps a connection's Work models in step with the provider. An empty listing
   * keeps the last good list, so an upstream fault never removes every model. The
   * policy revision is untouched: access reads this list live, and a background
   * bump would refuse an administrator's next save as a conflict.
   */
  private async storeSyncedModels(row: GatewayRow, models: readonly WorkDiscoveredModel[]) {
    if (!supportsModelSync(row.provider_id) || !row.work_model_sync) return;
    const ids = syncableModelIds(models);
    if (ids.length === 0) return;
    await this.pool.query(
      "UPDATE organization_provider_gateways SET work_synced_models=$2::jsonb,work_models_checked_at=NOW() WHERE id=$1 AND work_model_sync",
      [row.id, JSON.stringify(ids)],
    );
  }

  /** Claims connections due a listing check, so two API processes never repeat the work. */
  public async syncDueWorkModels(): Promise<void> {
    const due = await this.pool.query<GatewayRow>(
      `UPDATE organization_provider_gateways SET work_models_checked_at=NOW()
       WHERE id IN (
         SELECT id FROM organization_provider_gateways
         WHERE work_model_sync AND provider_id=ANY($1)
           AND (work_models_checked_at IS NULL
             OR work_models_checked_at < NOW()-INTERVAL '15 minutes'
             OR (work_synced_models='[]'::jsonb AND work_models_checked_at < NOW()-INTERVAL '1 minute'))
         ORDER BY work_models_checked_at NULLS FIRST LIMIT 8 FOR UPDATE SKIP LOCKED
       ) RETURNING *`,
      [MODEL_SYNC_PROVIDERS],
    );
    const results = await Promise.allSettled(
      due.rows.map(async (row) => {
        const target = this.limitTarget(row.organization_id, row.provider_id, row.encrypted_api_key);
        if (!target) throw new Error(`Work model sync has no usable credential for gateway ${row.id}`);
        await this.storeSyncedModels(row, await discoverWorkModels(target));
      }),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  public async discoverWorkGatewayModels(headers: IncomingHttpHeaders, gatewayId: string) {
    const actor = await this.browserAdmin(headers);
    const row = await this.gatewayRow(this.pool, actor.organization_id, gatewayId);
    const definition = supportedGatewayProvider(row.provider_id, "stored");
    const route = definition.routes[definition.kind]!;
    const apiKey = this.decryptApiKey(row.encrypted_api_key, actor.organization_id, row.provider_id);
    const target = { providerId: row.provider_id, protocol: definition.kind,
      upstreamBaseUrl: route.upstreamBaseUrl, apiKey };
    let accepted;
    let models;
    try {
      accepted = await listingKeyAccepted(target);
      models = accepted ? await discoverWorkModels(target) : [];
      if (accepted) await this.storeSyncedModels(row, models);
    } catch {
      throw new IdentityError(502, "work_model_discovery_failed", "Could not refresh provider models. Retry or enter a model ID manually.");
    }
    // Authority is rechecked after the slow upstream call; a lost session or admin role surfaces as itself.
    await this.browserAdmin(headers);
    if (!accepted) throw new IdentityError(422, "work_provider_key_refused", "The provider refused this API key. Update the key, then refresh.");
    for (const model of models) {
      const configured = row.work_model_pricing;
      const override = configured && Object.hasOwn(configured, model.id) ? configured[model.id] : undefined;
      if (override && WorkPricingSchema.safeParse(override).success) {
        model.workPricing = override;
        model.pricing = { prompt: override.input === undefined ? undefined : override.input / 1e6, completion: override.output === undefined ? undefined : override.output / 1e6 };
      }
    }
    return { models };
  }

  public async listOrganizationGateways(
    headers: IncomingHttpHeaders,
  ): Promise<OrganizationProviderGatewaysResponse> {
    const actor = await this.browserAdmin(headers);
    const [gateways, revision] = await Promise.all([
      this.pool.query<GatewayRow>(
        `
          SELECT
            id,
            organization_id,
            provider_id,
            encrypted_api_key,
            enabled_models,
          work_model_pricing,
            requests_per_minute,
            created_at,
            updated_at
          FROM organization_provider_gateways
          WHERE organization_id = $1
          ORDER BY created_at, id
        `,
        [actor.organization_id],
      ),
      this.organizationRevision(this.pool, actor.organization_id),
    ]);
    return {
      providerGateways: gateways.rows.map((row) =>
        organizationGatewayContract(row, revision),
      ),
    };
  }

  public async listAvailableGatewayProviders(
    headers: IncomingHttpHeaders,
  ): Promise<OrganizationProviderGatewayCatalogResponse> {
    await this.browserAdmin(headers);
    return {
      providers: providerGatewayDefinitions().map((provider) => ({
        ...(provider.defaultModel
          ? { defaultModel: provider.defaultModel }
          : {}),
        id: provider.id,
        kind: provider.kind,
        name: provider.name,
      })),
    };
  }

  public async listWorkOrganizationGateways(
    headers: IncomingHttpHeaders,
  ): Promise<WorkProviderGatewaysResponse> {
    const actor = await this.browserAdmin(headers);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const revision = await this.organizationRevision(
        client,
        actor.organization_id,
      );
      const rows = await client.query<GatewayRow>(
        "SELECT * FROM organization_provider_gateways WHERE organization_id=$1 AND provider_id=ANY($2::text[]) ORDER BY created_at,id",
        [actor.organization_id, WORK_GATEWAY_PROVIDER_IDS],
      );
      const result = {
        providerGateways: rows.rows.map((row) =>
          workGatewayContract(row, revision),
        ),
        revision,
      };
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  private async workGatewayMutation<T>(
    headers: IncomingHttpHeaders,
    expectedRevision: number,
    mutate: (
      client: PoolClient,
      actor: AdminRow,
      revision: number,
    ) => Promise<T>,
  ): Promise<T> {
    // Authenticate before reserving a pool client; Better Auth itself uses this
    // pool. Only the membership is reread after the organization lock is held.
    const actor = await this.browserAdmin(headers);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const revision = await this.bumpPolicyRevision(
        client,
        actor.organization_id,
        expectedRevision,
        actor.user_id,
      );
      const membership = await client.query<{ role: string }>(
        'SELECT role FROM member WHERE "organizationId"=$1 AND "userId"=$2',
        [actor.organization_id, actor.user_id],
      );
      if (!isOrganizationAdministrator(membership.rows[0]?.role as Role))
        throw new IdentityError(
          403,
          "admin_required",
          "Administrator access is required.",
        );
      const result = await mutate(client, actor, revision);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  public async createWorkOrganizationGateway(
    headers: IncomingHttpHeaders,
    input: CreateWorkProviderGatewayInput,
  ): Promise<WorkProviderGateway> {
    assertWorkGatewayProvider(input.providerId);
    const apiKey = normalizeApiKey(input.apiKey);
    validateGatewayRate(input.requestsPerMinute);
    try {
      const created = await this.workGatewayMutation(
        headers,
        input.expectedRevision,
        async (client, actor, revision) => {
          const id = randomUUID();
          const inserted = await client.query<GatewayRow>(
            `INSERT INTO organization_provider_gateways(id,organization_id,provider_id,encrypted_api_key,enabled_models,requests_per_minute,created_by_user_id,updated_by_user_id)
           VALUES($1,$2,$3,$4,'[]'::jsonb,$5,$6,$6) RETURNING *`,
            [
              id,
              actor.organization_id,
              input.providerId,
              this.encryptApiKey(
                apiKey,
                actor.organization_id,
                input.providerId,
              ),
              input.requestsPerMinute,
              actor.user_id,
            ],
          );
          const row = inserted.rows[0]!;
          await recordAuditEvent(client, {
            action: "organization_provider.created",
            actorUserId: actor.user_id,
            organizationId: actor.organization_id,
            subjectType: "organization_provider",
            subjectId: id,
            metadata: {
              surface: "work",
              providerId: input.providerId,
              requestsPerMinute: input.requestsPerMinute,
              credentialConfigured: true,
              sharedWithCode: true,
            },
          });
          return workGatewayContract(row, revision);
        },
      );
      await this.syncDueWorkModels().catch(() => undefined);
      return created;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
      )
        throw new IdentityError(
          409,
          "provider_gateway_exists",
          "This company provider is already configured. Edit its shared connection.",
        );
      throw error;
    }
  }
  public async updateWorkOrganizationGateway(
    headers: IncomingHttpHeaders,
    gatewayId: string,
    input: UpdateWorkProviderGatewayInput,
  ): Promise<WorkProviderGateway> {
    if (
      input.apiKey === undefined &&
      input.requestsPerMinute === undefined &&
      input.autoModels === undefined
    )
      throw new IdentityError(
        400,
        "invalid_request",
        "Choose a company provider setting to update.",
      );
    const nextKey =
      input.apiKey === undefined ? undefined : normalizeApiKey(input.apiKey);
    if (input.requestsPerMinute !== undefined)
      validateGatewayRate(input.requestsPerMinute);
    const result = await this.workGatewayMutation(
      headers,
      input.expectedRevision,
      async (client, actor, revision) => {
        const current = await this.gatewayRow(
          client,
          actor.organization_id,
          gatewayId,
        );
        assertWorkGatewayProvider(current.provider_id);
        if (input.autoModels !== undefined && !supportsModelSync(current.provider_id))
          throw new IdentityError(
            400,
            "work_model_sync_unsupported",
            "This provider's models must be chosen individually.",
          );
        const rate = input.requestsPerMinute ?? current.requests_per_minute;
        const sync = input.autoModels ?? current.work_model_sync ?? true;
        const key =
          nextKey === undefined
            ? current.encrypted_api_key
            : this.encryptApiKey(
                nextKey,
                actor.organization_id,
                current.provider_id,
              );
        // Deliberately do not read, normalize, or rewrite enabled_models: it is a
        // Code-owned assignment and must survive a Work key/rate change untouched.
        const updated = await client.query<GatewayRow>(
          `UPDATE organization_provider_gateways SET encrypted_api_key=$3,requests_per_minute=$4,updated_at=NOW(),updated_by_user_id=$5,
             work_model_sync=$6,work_models_checked_at=CASE WHEN $6 AND NOT work_model_sync THEN NULL ELSE work_models_checked_at END
           WHERE id=$1 AND organization_id=$2 RETURNING *`,
          [gatewayId, actor.organization_id, key, rate, actor.user_id, sync],
        );
        await recordAuditEvent(client, {
          action: "organization_provider.updated",
          actorUserId: actor.user_id,
          organizationId: actor.organization_id,
          subjectType: "organization_provider",
          subjectId: gatewayId,
          metadata: {
            surface: "work",
            providerId: current.provider_id,
            requestsPerMinute: rate,
            credentialRotated: nextKey !== undefined,
            sharedWithCode: true,
            ...(input.autoModels === undefined ? {} : { autoModels: input.autoModels }),
          },
        });
        return workGatewayContract(updated.rows[0]!, revision);
      },
    );
    if (input.autoModels) await this.syncDueWorkModels().catch(() => undefined);
    return result;
  }

  public async createOrganizationGateway(
    headers: IncomingHttpHeaders,
    input: CreateOrganizationProviderGatewayInput,
  ): Promise<OrganizationProviderGateway> {
    if (!PROVIDER_ID_PATTERN.test(input.providerId)) {
      throw new IdentityError(
        400,
        "invalid_provider",
        "Choose a supported cloud provider.",
      );
    }
    const provider = supportedGatewayProvider(input.providerId, "input");
    const apiKey = normalizeApiKey(input.apiKey);
    const enabledModels = normalizedModels(input.enabledModels);
    if (
      !Number.isInteger(input.requestsPerMinute) ||
      input.requestsPerMinute < 1 ||
      input.requestsPerMinute > 600
    ) {
      throw new IdentityError(
        400,
        "invalid_provider_rate_limit",
        "Provider requests per minute must be between 1 and 600.",
      );
    }
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const actor = await this.browserAdmin(headers, client);
      const revision = await this.bumpPolicyRevision(
        client,
        actor.organization_id,
        input.expectedRevision,
        actor.user_id,
      );
      const currentActor = await this.browserAdmin(headers, client);
      if (
        currentActor.user_id !== actor.user_id ||
        currentActor.organization_id !== actor.organization_id
      ) {
        throw new IdentityError(
          403,
          "admin_required",
          "Administrator access is required.",
        );
      }
      const id = randomUUID();
      const result = await client.query<GatewayRow>(
        `
          INSERT INTO organization_provider_gateways (
            id, organization_id, provider_id, encrypted_api_key, enabled_models,
            requests_per_minute, created_by_user_id, updated_by_user_id
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $7)
          RETURNING
            id, organization_id, provider_id, encrypted_api_key, enabled_models,
            requests_per_minute, created_at, updated_at
        `,
        [
          id,
          actor.organization_id,
          provider.id,
          this.encryptApiKey(apiKey, actor.organization_id, provider.id),
          JSON.stringify(enabledModels),
          input.requestsPerMinute,
          actor.user_id,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error(
          "The organization provider connection could not be created",
        );
      }
      await recordAuditEvent(client, {
        action: "organization_provider.created",
        actorUserId: actor.user_id,
        metadata: {
          enabledModelCount: enabledModels.length,
          providerId: provider.id,
          requestsPerMinute: input.requestsPerMinute,
        },
        organizationId: actor.organization_id,
        subjectId: id,
        subjectType: "organization_provider",
      });
      await client.query("COMMIT");
      committed = true;
      void this.syncDueWorkModels().catch(() => undefined);
      return organizationGatewayContract(row, revision);
    } catch (error) {
      if (!committed) await client.query("ROLLBACK");
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "23505"
      ) {
        throw new IdentityError(
          409,
          "provider_gateway_exists",
          "This provider is already connected for the organization.",
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async updateOrganizationGateway(
    headers: IncomingHttpHeaders,
    gatewayId: string,
    input: UpdateOrganizationProviderGatewayInput,
  ): Promise<OrganizationProviderGateway> {
    const nextModels = input.enabledModels
      ? normalizedModels(input.enabledModels)
      : undefined;
    const nextApiKey =
      input.apiKey === undefined ? undefined : normalizeApiKey(input.apiKey);
    if (
      input.requestsPerMinute !== undefined &&
      (!Number.isInteger(input.requestsPerMinute) ||
        input.requestsPerMinute < 1 ||
        input.requestsPerMinute > 600)
    ) {
      throw new IdentityError(
        400,
        "invalid_provider_rate_limit",
        "Provider requests per minute must be between 1 and 600.",
      );
    }
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const actor = await this.browserAdmin(headers, client);
      const revision = await this.bumpPolicyRevision(
        client,
        actor.organization_id,
        input.expectedRevision,
        actor.user_id,
      );
      const currentActor = await this.browserAdmin(headers, client);
      if (
        currentActor.user_id !== actor.user_id ||
        currentActor.organization_id !== actor.organization_id
      ) {
        throw new IdentityError(
          403,
          "admin_required",
          "Administrator access is required.",
        );
      }
      const current = await this.gatewayRow(
        client,
        actor.organization_id,
        gatewayId,
      );
      const enabledModels =
        nextModels ?? modelsFromDatabase(current.enabled_models);
      const requestsPerMinute =
        input.requestsPerMinute ?? current.requests_per_minute;
      const encryptedApiKey = nextApiKey
        ? this.encryptApiKey(
            nextApiKey,
            actor.organization_id,
            current.provider_id,
          )
        : current.encrypted_api_key;
      const result = await client.query<GatewayRow>(
        `
          UPDATE organization_provider_gateways
          SET
            encrypted_api_key = $3,
            enabled_models = $4::jsonb,
            requests_per_minute = $5,
            updated_at = NOW(),
            updated_by_user_id = $6
          WHERE id = $1 AND organization_id = $2
          RETURNING
            id, organization_id, provider_id, encrypted_api_key, enabled_models,
            requests_per_minute, created_at, updated_at
        `,
        [
          gatewayId,
          actor.organization_id,
          encryptedApiKey,
          JSON.stringify(enabledModels),
          requestsPerMinute,
          actor.user_id,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error(
          "The organization provider connection could not be updated",
        );
      }
      await recordAuditEvent(client, {
        action: "organization_provider.updated",
        actorUserId: actor.user_id,
        metadata: {
          credentialRotated: Boolean(nextApiKey),
          enabledModelCount: enabledModels.length,
          providerId: current.provider_id,
          requestsPerMinute,
        },
        organizationId: actor.organization_id,
        subjectId: gatewayId,
        subjectType: "organization_provider",
      });
      await client.query("COMMIT");
      committed = true;
      return organizationGatewayContract(row, revision);
    } catch (error) {
      if (!committed) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async deleteOrganizationGateway(
    headers: IncomingHttpHeaders,
    gatewayId: string,
    expectedRevision: number,
  ): Promise<void> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const actor = await this.browserAdmin(headers, client);
      await this.bumpPolicyRevision(
        client,
        actor.organization_id,
        expectedRevision,
        actor.user_id,
      );
      const currentActor = await this.browserAdmin(headers, client);
      if (
        currentActor.user_id !== actor.user_id ||
        currentActor.organization_id !== actor.organization_id
      ) {
        throw new IdentityError(
          403,
          "admin_required",
          "Administrator access is required.",
        );
      }
      const current = await this.gatewayRow(
        client,
        actor.organization_id,
        gatewayId,
      );
      await client.query(
        `DELETE FROM organization_provider_gateways WHERE id = $1 AND organization_id = $2`,
        [gatewayId, actor.organization_id],
      );
      await recordAuditEvent(client, {
        action: "organization_provider.deleted",
        actorUserId: actor.user_id,
        metadata: { providerId: current.provider_id },
        organizationId: actor.organization_id,
        subjectId: gatewayId,
        subjectType: "organization_provider",
      });
      await client.query("COMMIT");
      committed = true;
    } catch (error) {
      if (!committed) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async enabledGatewaysForDevice(
    authorization: string | undefined,
  ): Promise<{ deviceId: string; gateways: GatewayRow[] }> {
    const device = await this.enrollment.authenticatedDevice(authorization);
    const policy = await this.enrollment.effectivePolicyForMember(
      device.organizationId,
      device.memberId,
    );
    const gateways = await this.pool.query<GatewayRow>(
      `
        SELECT
          id, organization_id, provider_id, encrypted_api_key, enabled_models,
          requests_per_minute, created_at, updated_at
        FROM organization_provider_gateways
        WHERE organization_id = $1
        ORDER BY created_at, id
      `,
      [device.organizationId],
    );
    return {
      deviceId: device.deviceId,
      gateways: gateways.rows.filter(
        (row) =>
          providerEnabled(policy, row.provider_id) &&
          modelsFromDatabase(row.enabled_models).length > 0,
      ),
    };
  }

  public async desktopGatewayMetadata(
    authorization: string | undefined,
  ): Promise<ManagedProviderGateway[]> {
    const { gateways } = await this.enabledGatewaysForDevice(authorization);
    return gateways.map((row) => desktopGatewayContract(row, this.config));
  }

  public async desktopCredentials(
    authorization: string | undefined,
  ): Promise<ManagedProviderCredentialsResponse> {
    const { deviceId, gateways } =
      await this.enabledGatewaysForDevice(authorization);
    return {
      providers: gateways.map((gateway) =>
        this.issueGatewayToken(deviceId, gateway.id),
      ),
    };
  }

  public async authorizeGatewayRequest(
    authorization: string | undefined,
    gatewayId: string,
    route: ProviderGatewayRoute,
    product: "code" | "work" = "code",
  ): Promise<AuthorizedProviderGatewayRequest> {
    if (product === "code")
      return this.authorizeGatewayRequestSnapshot(
        authorization,
        gatewayId,
        route,
        product,
        this.pool,
      );
    // Reject malformed credentials before allocating a database transaction.
    this.readGatewayToken(authorization);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await this.authorizeGatewayRequestSnapshot(
        authorization,
        gatewayId,
        route,
        product,
        client,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  private async authorizeGatewayRequestSnapshot(
    authorization: string | undefined,
    gatewayId: string,
    route: ProviderGatewayRoute,
    product: "code" | "work",
    database: Pool | PoolClient,
  ): Promise<AuthorizedProviderGatewayRequest> {
    const claims = this.readGatewayToken(authorization);
    if ((claims.p ?? "code") !== product || (product === "work" && !claims.s))
      throw new IdentityError(
        403,
        "provider_gateway_product_denied",
        "This credential cannot access that product.",
      );
    if (claims.g !== gatewayId) {
      throw new IdentityError(
        403,
        "provider_gateway_scope_invalid",
        "This organization provider credential cannot access that provider.",
      );
    }
    const result = await database.query<GatewayAccessRow>(
      `
        SELECT
          gateways.id,
          gateways.organization_id,
          gateways.provider_id,
          gateways.encrypted_api_key,
          gateways.enabled_models,
          gateways.work_model_pricing,
          gateways.requests_per_minute,
          gateways.created_at,
          gateways.updated_at,
          devices.id AS device_id,
          members.id AS member_id,
          users.id AS user_id
        FROM organization_provider_gateways gateways
        JOIN devices ON devices.id = $2 AND devices.organization_id = gateways.organization_id
        JOIN "user" users ON users.id = devices.user_id
        JOIN member members
          ON members."organizationId" = devices.organization_id
          AND members."userId" = users.id
        WHERE gateways.id = $1
          AND devices.revoked_at IS NULL
          ${product === "work" ? "AND EXISTS (SELECT 1 FROM device_sessions sessions WHERE sessions.id::text=$3 AND sessions.device_id=devices.id AND sessions.revoked_at IS NULL AND EXISTS (SELECT 1 FROM device_refresh_tokens refresh WHERE refresh.session_id=sessions.id AND refresh.consumed_at IS NULL AND refresh.expires_at > NOW()))" : ""}
        LIMIT 1
      `,
      product === "work"
        ? [gatewayId, claims.d, claims.s]
        : [gatewayId, claims.d],
    );
    const row = result.rows[0];
    if (!row) {
      throw new IdentityError(
        403,
        "provider_gateway_access_revoked",
        "This device no longer has access to the organization provider.",
      );
    }
    const policy =
      product === "work" && this.work
        ? await this.work.effectiveForMember(
            row.organization_id,
            row.member_id,
            database,
          )
        : await this.enrollment.effectivePolicyForMember(
            row.organization_id,
            row.member_id,
          );
    if (product === "work" && (!("enabled" in policy) || !policy.enabled))
      throw new IdentityError(403, "work_disabled", "Work access is disabled.");
    if (!providerEnabled(policy, row.provider_id)) {
      throw new IdentityError(
        403,
        "provider_gateway_policy_denied",
        "This provider is no longer assigned to your organization access policy.",
      );
    }
    const definition = supportedGatewayProvider(row.provider_id, "stored");
    if (product === "work" && route !== definition.kind)
      throw new IdentityError(
        403,
        "provider_gateway_route_denied",
        "Choose the Work provider protocol.",
      );
    const selectedRoute = definition.routes[route];
    if (!selectedRoute) {
      throw new IdentityError(
        404,
        "provider_gateway_route_unavailable",
        "This provider does not support that coding-tool protocol.",
      );
    }
    return {
      allowedModels:
        product === "work" && "providerModels" in policy
          ? (policy.providerModels.find((p) => p.providerId === row.provider_id)
              ?.modelIds ?? [])
          : modelsFromDatabase(row.enabled_models),
      apiKey: this.decryptApiKey(
        row.encrypted_api_key,
        row.organization_id,
        row.provider_id,
      ),
      organizationId: row.organization_id,
      deviceId: row.device_id,
      gatewayId: row.id,
      providerId: row.provider_id,
      requestsPerMinute: row.requests_per_minute,
      upstreamBaseUrl: selectedRoute.upstreamBaseUrl,
      ...(product === "work" ? { workModelPricing: row.work_model_pricing } : {}),
    };
  }

  public async desktopWorkGatewayMetadata(
    authorization: string | undefined,
  ): Promise<ManagedProviderGateway[]> {
    const device = await this.enrollment.authenticatedDevice(authorization);
    const policy = await this.work?.effectiveForMember(
      device.organizationId,
      device.memberId,
    );
    if (!policy?.enabled) return [];
    const rows = await this.pool.query<GatewayRow>(
      "SELECT * FROM organization_provider_gateways WHERE organization_id=$1 ORDER BY created_at,id",
      [device.organizationId],
    );
    return rows.rows
      .filter((row) => providerEnabled(policy, row.provider_id))
      .map((row): ManagedProviderGateway => {
        const provider = supportedGatewayProvider(row.provider_id, "stored");
        return {
          gatewayId: row.id,
          providerId: provider.id,
          name: provider.name,
          kind: provider.kind,
          enabledModels:
            policy.providerModels.find((p) => p.providerId === row.provider_id)
              ?.modelIds ?? [],
          supportedAgents: ["work"],
          routeBaseUrls: {
            [provider.kind]: `${this.config.publicUrl}/api/v1/work/provider-gateway/${row.id}/${provider.kind}${provider.kind === "openai" ? "/v1" : ""}`,
          },
        };
      });
  }
  public async desktopWorkCredentials(
    authorization: string | undefined,
  ): Promise<ManagedProviderCredentialsResponse> {
    const device = await this.enrollment.authenticatedDevice(authorization);
    const providers = await this.desktopWorkGatewayMetadata(authorization);
    return {
      providers: providers
        .filter((p) => p.enabledModels.length > 0)
        .map((p) =>
          this.issueGatewayToken(
            device.deviceId,
            p.gatewayId,
            device.sessionId,
          ),
        ),
    };
  }

  public providerDefinition(providerId: string): ProviderGatewayDefinition {
    return supportedGatewayProvider(providerId, "input");
  }
}
