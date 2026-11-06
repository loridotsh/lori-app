import type { IncomingHttpHeaders } from "node:http";
import type { Pool, PoolClient } from "pg";
import type {
  EffectiveWorkDelegation,
  EnterpriseWorkPolicy,
  ProjectPolicy,
  Role,
  WorkDelegationPolicy,
  WorkPolicyInput,
  WorkPolicyOverrides,
  WorkMemberPolicy,
  ManagedCatalogItem,
  WorkProviderModels,
} from "@lori-enterprise/contracts";
import { z } from "zod";
import { syncedModelIds } from "./provider-gateway-service.js";
import { MODEL_SYNC_PROVIDERS } from "./work-model-discovery.js";
import type { IdentityService } from "./identity-service.js";
import type { TeamService } from "./team-service.js";
import type { EnrollmentService } from "./enrollment-service.js";
import { IdentityError } from "./identity-service.js";
import {
  workCatalog,
  validateWorkCatalog,
  WORK_GATEWAY_PROVIDER_IDS,
} from "./work-catalog.js";
import { recordAuditEvent } from "./audit.js";
import { isOrganizationAdministrator, parseOrganizationRole } from "./authority.js";
import {
  WorkDelegationSchema,
  approveWorkExcess,
  boundWorkContribution,
  delegationExcess,
  delegationRefused,
  effectiveWorkDelegation,
  normalizeWorkDelegation,
  storedDocument,
  storedWorkDelegation,
  workModelRows,
} from "./delegation.js";
import { WorkResourceScope } from "./work-resources.js";

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const WorkModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const Catalog = z
  .array(
    z
      .object({
        id: Id,
        type: z.enum(["app", "plugin", "provider", "skill"]),
        enabled: z.boolean(),
      })
      .strict(),
  )
  .max(500);
const Personal = z
  .object({ plugins: z.boolean(), providers: z.boolean(), skills: z.boolean() })
  .strict();
const PersonalOverrides = z
  .object({
    plugins: z.boolean().nullable(),
    providers: z.boolean().nullable(),
    skills: z.boolean().nullable(),
  })
  .strict();
export const WorkPolicySchema = z
  .object({
    enabled: z.boolean(),
    personalInstallations: Personal,
    managedCatalog: Catalog,
    providerModels: z
      .array(
        z
          .object({
            providerId: Id,
            modelIds: z.array(WorkModelSchema).max(32),
          })
          .strict(),
      )
      .max(64),
    forceAskMe: z.boolean(),
    memoryAllowed: z.boolean(),
  })
  .strict();
export const WorkOverridesSchema = z
  .object({
    enabled: z.boolean().nullable(),
    personalInstallations: PersonalOverrides,
    managedCatalog: Catalog,
    providerModels: z
      .array(
        z
          .object({
            providerId: Id,
            modelId: WorkModelSchema,
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(2048),
  })
  .strict();
export const defaultWorkPolicy = (): WorkPolicyInput => ({
  enabled: true,
  personalInstallations: { plugins: true, providers: true, skills: true },
  managedCatalog: [],
  providerModels: [],
  forceAskMe: false,
  memoryAllowed: true,
});
const emptyTeamPolicy = (): WorkPolicyInput => ({
  ...defaultWorkPolicy(),
  enabled: false,
  personalInstallations: { plugins: false, providers: false, skills: false },
});
export const emptyWorkOverrides = (): WorkPolicyOverrides => ({
  enabled: null,
  personalInstallations: { plugins: null, providers: null, skills: null },
  managedCatalog: [],
  providerModels: [],
});

function modelsMap(models: WorkProviderModels[]): Map<string, Set<string>> {
  return new Map(models.map((p) => [p.providerId, new Set(p.modelIds)]));
}
function modelContract(models: Map<string, Set<string>>): WorkProviderModels[] {
  return [...models]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([providerId, ids]) => ({ providerId, modelIds: [...ids].sort() }));
}
export function applyWorkOverrides(
  base: WorkPolicyInput,
  overrides: WorkPolicyOverrides,
): WorkPolicyInput {
  const catalog = new Map(
    base.managedCatalog.map((i) => [`${i.type}:${i.id}`, i]),
  );
  for (const i of overrides.managedCatalog) catalog.set(`${i.type}:${i.id}`, i);
  const models = modelsMap(base.providerModels);
  for (const i of overrides.providerModels) {
    const ids = models.get(i.providerId) ?? new Set<string>();
    if (i.enabled) ids.add(i.modelId);
    else ids.delete(i.modelId);
    models.set(i.providerId, ids);
  }
  return {
    ...base,
    enabled: overrides.enabled ?? base.enabled,
    personalInstallations: {
      plugins:
        overrides.personalInstallations.plugins ??
        base.personalInstallations.plugins,
      providers:
        overrides.personalInstallations.providers ??
        base.personalInstallations.providers,
      skills:
        overrides.personalInstallations.skills ??
        base.personalInstallations.skills,
    },
    managedCatalog: [...catalog.values()].sort((a, b) =>
      `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`),
    ),
    providerModels: modelContract(models),
  };
}
export function unionWorkPolicies(
  organization: WorkPolicyInput,
  teams: WorkPolicyInput[],
): WorkPolicyInput {
  const catalog = new Map<string, ManagedCatalogItem>(
    organization.managedCatalog.map((i) => [`${i.type}:${i.id}`, i]),
  );
  const models = new Map<string, Set<string>>();
  for (const p of [organization, ...teams]) {
    for (const i of p.managedCatalog) {
      const key = `${i.type}:${i.id}`;
      if (i.enabled || !catalog.has(key)) catalog.set(key, i);
    }
    for (const provider of p.providerModels) {
      const ids = models.get(provider.providerId) ?? new Set<string>();
      provider.modelIds.forEach((m) => ids.add(m));
      models.set(provider.providerId, ids);
    }
  }
  return {
    ...organization,
    enabled: organization.enabled || teams.some((t) => t.enabled),
    personalInstallations: {
      plugins:
        organization.personalInstallations.plugins ||
        teams.some((t) => t.personalInstallations.plugins),
      providers:
        organization.personalInstallations.providers ||
        teams.some((t) => t.personalInstallations.providers),
      skills:
        organization.personalInstallations.skills ||
        teams.some((t) => t.personalInstallations.skills),
    },
    managedCatalog: [...catalog.values()].sort((a, b) =>
      `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`),
    ),
    providerModels: modelContract(models),
  };
}

/**
 * Adds models a connection keeps in step with its provider. Stored policy never
 * changes: administrators edit only what they chose. A provider the organization
 * explicitly turned off stays off, and member restrictions apply after this.
 */
export function withSyncedModels(
  policy: WorkPolicyInput,
  gateways: readonly { providerId: string; modelIds: readonly string[] }[],
): WorkPolicyInput {
  const catalog = new Map(policy.managedCatalog.map((i) => [`${i.type}:${i.id}`, i]));
  const models = modelsMap(policy.providerModels);
  for (const { providerId, modelIds } of gateways) {
    const key = `provider:${providerId}`;
    if (modelIds.length === 0 || catalog.get(key)?.enabled === false) continue;
    catalog.set(key, { id: providerId, type: "provider", enabled: true });
    const ids = models.get(providerId) ?? new Set<string>();
    modelIds.forEach((id) => ids.add(id));
    models.set(providerId, ids);
  }
  return { ...policy, managedCatalog: [...catalog.values()], providerModels: modelContract(models) };
}

/**
 * An organization administrator uses everything the organization approves
 * (team-delegation approvals plus defaults) and any team grant. Their own
 * member overrides may add access but never silently remove it.
 */
export function administratorWorkPolicy(
  organization: WorkPolicyInput,
  ceiling: EffectiveWorkDelegation,
  inherited: WorkPolicyInput,
  overrides: WorkPolicyOverrides,
): WorkPolicyInput {
  const approved = unionWorkPolicies(
    {
      ...organization,
      enabled: ceiling.enabled,
      personalInstallations: { ...ceiling.personalInstallations },
      managedCatalog: unionWorkPolicies(organization, [
        {
          ...organization,
          managedCatalog: ceiling.managedCatalog.map((item) => ({
            ...item,
            enabled: true,
          })),
        },
      ]).managedCatalog,
      providerModels: ceiling.providerModels,
    },
    [inherited],
  );
  return applyWorkOverrides(approved, {
    enabled: overrides.enabled === true ? true : null,
    personalInstallations: {
      plugins: overrides.personalInstallations.plugins === true ? true : null,
      providers:
        overrides.personalInstallations.providers === true ? true : null,
      skills: overrides.personalInstallations.skills === true ? true : null,
    },
    managedCatalog: overrides.managedCatalog.filter((item) => item.enabled),
    providerModels: overrides.providerModels.filter((model) => model.enabled),
  });
}

type DB = Pool | PoolClient;
type Scope = { teamId?: string; memberId?: string };
export class WorkService {
  public constructor(
    private readonly pool: Pool,
    private readonly identity: IdentityService,
    private readonly teams: TeamService,
    private readonly enrollment: EnrollmentService,
  ) {}
  private async readSnapshot<T>(
    read: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await read(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  private async revision(org: string, db: DB): Promise<number> {
    const r = await db.query<{ revision: string }>(
      "SELECT revision::text FROM organization_policies WHERE organization_id=$1",
      [org],
    );
    const revision = Number(r.rows[0]?.revision);
    if (!Number.isSafeInteger(revision) || revision <= 0)
      throw new IdentityError(
        503,
        "work_policy_unavailable",
        "Work policy is unavailable.",
      );
    return revision;
  }
  private contract(p: WorkPolicyInput, revision: number): EnterpriseWorkPolicy {
    return { ...p, schemaVersion: 1, revision };
  }
  private storedPolicy(value: unknown): WorkPolicyInput {
    const parsed = WorkPolicySchema.safeParse(value);
    if (parsed.success) {
      try {
        this.validate(parsed.data);
        return parsed.data;
      } catch {
        /* Stored policy corruption must fail closed. */
      }
    }
    throw new IdentityError(
      503,
      "work_policy_unavailable",
      "Work policy is unavailable. Contact your administrator.",
    );
  }
  private storedOverrides(value: unknown): WorkPolicyOverrides {
    const parsed = WorkOverridesSchema.safeParse(value);
    if (parsed.success) {
      try {
        this.validate(parsed.data);
        return parsed.data;
      } catch {
        /* Fail closed on unknown or duplicate grants. */
      }
    }
    throw new IdentityError(
      503,
      "work_policy_unavailable",
      "Work policy is unavailable. Contact your administrator.",
    );
  }
  private async organization(org: string, db: DB): Promise<WorkPolicyInput> {
    const r = await db.query<{ policy: WorkPolicyInput }>(
      "SELECT policy FROM organization_work_policies WHERE organization_id=$1",
      [org],
    );
    if (!r.rows[0])
      throw new IdentityError(
        503,
        "work_policy_unavailable",
        "Work policy has not been provisioned.",
      );
    return this.storedPolicy(r.rows[0].policy);
  }
  /** What members actually receive. Editors read `organization`, never this. */
  private async organizationWithSyncedModels(org: string, db: DB): Promise<WorkPolicyInput> {
    const r = await db.query<{ provider_id: string; work_synced_models: unknown }>(
      "SELECT provider_id,work_synced_models FROM organization_provider_gateways WHERE organization_id=$1 AND work_model_sync AND provider_id=ANY($2)",
      [org, MODEL_SYNC_PROVIDERS],
    );
    return withSyncedModels(
      await this.organization(org, db),
      r.rows.map((row) => ({ providerId: row.provider_id, modelIds: syncedModelIds(row.work_synced_models) })),
    );
  }
  private async teamPolicy(
    team: string,
    org: WorkPolicyInput,
    db: DB,
  ): Promise<WorkPolicyInput> {
    const r = await db.query<{ policy: WorkPolicyInput }>(
      "SELECT policy FROM team_work_policies WHERE team_id=$1",
      [team],
    );
    return {
      ...(r.rows[0] ? this.storedPolicy(r.rows[0].policy) : emptyTeamPolicy()),
      forceAskMe: org.forceAskMe,
      memoryAllowed: org.memoryAllowed,
    };
  }
  private async overrides(
    member: string,
    team: string | undefined,
    db: DB,
  ): Promise<WorkPolicyOverrides> {
    const r = team
      ? await db.query<{ overrides: WorkPolicyOverrides }>(
          "SELECT overrides FROM team_member_work_policy_overrides WHERE team_member_id=$1",
          [team],
        )
      : await db.query<{ overrides: WorkPolicyOverrides }>(
          "SELECT overrides FROM member_work_policy_overrides WHERE member_id=$1",
          [member],
        );
    return r.rows[0]
      ? this.storedOverrides(r.rows[0].overrides)
      : emptyWorkOverrides();
  }
  private async targetMember(
    org: string,
    member: string,
    db: DB,
  ): Promise<Role> {
    const r = await db.query<{ role: string }>(
      'SELECT role FROM member WHERE id=$1 AND "organizationId"=$2',
      [member, org],
    );
    if (!r.rows[0])
      throw new IdentityError(404, "member_not_found", "Member not found.");
    return parseOrganizationRole(r.rows[0].role);
  }
  /** Stored team-delegation approvals and the full approved set (with defaults). */
  public async delegation(
    org: string,
    db: DB,
    organization?: WorkPolicyInput,
  ): Promise<{ stored: EffectiveWorkDelegation; effective: EffectiveWorkDelegation }> {
    const r = await db.query<{ delegation: unknown }>(
      "SELECT delegation FROM organization_work_policies WHERE organization_id=$1",
      [org],
    );
    const stored = storedWorkDelegation(r.rows[0]?.delegation);
    return {
      stored,
      effective: effectiveWorkDelegation(
        stored,
        organization ?? (await this.organization(org, db)),
      ),
    };
  }
  private async membership(
    team: string,
    member: string,
    db: DB,
  ): Promise<string> {
    const r = await db.query<{ id: string }>(
      "SELECT id FROM team_member WHERE team_id=$1 AND member_id=$2",
      [team, member],
    );
    if (!r.rows[0])
      throw new IdentityError(
        404,
        "team_member_not_found",
        "Team member not found.",
      );
    return r.rows[0].id;
  }
  private async inherited(
    orgId: string,
    member: string,
    organization: WorkPolicyInput,
    db: DB,
  ): Promise<WorkPolicyInput> {
    const r = await db.query<{ team_id: string; id: string }>(
      "SELECT memberships.team_id,memberships.id FROM team_member memberships JOIN team teams ON teams.id=memberships.team_id WHERE memberships.member_id=$1 AND teams.organization_id=$2",
      [member, orgId],
    );
    // A team grants only what the organization approved for team delegation.
    const ceiling = r.rows.length
      ? (await this.delegation(orgId, db, organization)).effective
      : undefined;
    const contributions: WorkPolicyInput[] = [];
    for (const t of r.rows)
      contributions.push(
        boundWorkContribution(
          applyWorkOverrides(
            await this.teamPolicy(t.team_id, organization, db),
            await this.overrides(member, t.id, db),
          ),
          ceiling!,
        ),
      );
    return unionWorkPolicies(organization, contributions);
  }
  public async effectiveForMember(
    orgId: string,
    member: string,
    db: DB = this.pool,
  ): Promise<EnterpriseWorkPolicy> {
    if (db === this.pool) {
      return this.readSnapshot((client) =>
        this.effectiveForMember(orgId, member, client),
      );
    }
    const role = await this.targetMember(orgId, member, db);
    const org = await this.organizationWithSyncedModels(orgId, db);
    const inherited = await this.inherited(orgId, member, org, db);
    const overrides = await this.overrides(member, undefined, db);
    return this.contract(
      isOrganizationAdministrator(role)
        ? administratorWorkPolicy(
            org,
            (await this.delegation(orgId, db, org)).effective,
            inherited,
            overrides,
          )
        : applyWorkOverrides(inherited, overrides),
      await this.revision(orgId, db),
    );
  }
  /**
   * The member's Work resource decisions for a scope: private Work, or a
   * shared project whose policy may assign resources. Every enforcement path
   * (capabilities, submission, worker claims, plugins, skills) uses this.
   */
  public async resourceScope(
    orgId: string,
    member: string,
    db: DB = this.pool,
    project?: ProjectPolicy,
  ): Promise<WorkResourceScope> {
    if (db === this.pool)
      return this.readSnapshot((client) =>
        this.resourceScope(orgId, member, client, project),
      );
    const role = await this.targetMember(orgId, member, db);
    const organization = await this.organizationWithSyncedModels(orgId, db);
    return new WorkResourceScope({
      administrator: isOrganizationAdministrator(role),
      approved: (await this.delegation(orgId, db, organization)).effective,
      memberOverrides: await this.overrides(member, undefined, db),
      organization,
      policy: await this.effectiveForMember(orgId, member, db),
      ...(project ? { project } : {}),
    });
  }
  public async own(
    headers: IncomingHttpHeaders,
  ): Promise<EnterpriseWorkPolicy> {
    const v = await this.identity.getViewer(headers);
    const r = await this.pool.query<{ id: string }>(
      'SELECT id FROM member WHERE "organizationId"=$1 AND "userId"=$2',
      [v.organization.id, v.user.id],
    );
    if (!r.rows[0])
      throw new IdentityError(
        403,
        "membership_required",
        "Membership is no longer active.",
      );
    return this.effectiveForMember(v.organization.id, r.rows[0].id);
  }
  public async desktop(
    authorization: string | undefined,
  ): Promise<EnterpriseWorkPolicy> {
    const d = await this.enrollment.authenticatedDevice(authorization);
    return this.effectiveForMember(d.organizationId, d.memberId);
  }
  public async catalog(headers: IncomingHttpHeaders) {
    const v = await this.identity.getViewer(headers);
    const r = await this.pool.query<{ provider_id: string }>(
      "SELECT provider_id FROM organization_provider_gateways WHERE organization_id=$1",
      [v.organization.id],
    );
    return {
      ...workCatalog,
      connectedOrganizationProviderIds: r.rows
        .map((r) => r.provider_id)
        .filter((id) =>
          WORK_GATEWAY_PROVIDER_IDS.some((candidate) => candidate === id),
        ),
    };
  }
  public async read(
    headers: IncomingHttpHeaders,
    scope: Scope = {},
    db: DB = this.pool,
  ): Promise<EnterpriseWorkPolicy | WorkMemberPolicy> {
    let orgId: string;
    let teamId: string | undefined;
    if (scope.teamId) {
      const a = await this.teams.assertTeamAdmin(headers, scope.teamId, db);
      orgId = a.actor.organization_id;
      teamId = a.team.id;
    } else orgId = (await this.identity.requireAdmin(headers)).organization.id;
    const read = (database: DB) =>
      this.readScope(orgId, teamId, scope.memberId, database);
    return db === this.pool ? this.readSnapshot(read) : read(db);
  }
  private async readScope(
    orgId: string,
    teamId: string | undefined,
    memberId: string | undefined,
    db: DB,
  ): Promise<EnterpriseWorkPolicy | WorkMemberPolicy> {
    const org = await this.organization(orgId, db);
    const rev = await this.revision(orgId, db);
    // Team scopes show what the team may grant, so the UI can explain it.
    const delegation = teamId
      ? (await this.delegation(orgId, db, org)).effective
      : undefined;
    if (!memberId)
      return {
        ...this.contract(
          teamId ? await this.teamPolicy(teamId, org, db) : org,
          rev,
        ),
        ...(delegation ? { delegation } : {}),
      };
    await this.targetMember(orgId, memberId, db);
    const tm = teamId ? await this.membership(teamId, memberId, db) : undefined;
    const inherited = teamId
      ? await this.teamPolicy(teamId, org, db)
      : await this.inherited(orgId, memberId, await this.organizationWithSyncedModels(orgId, db), db);
    const overrides = await this.overrides(memberId, tm, db);
    return {
      // Outside a team this is the member's real result, including administrator authority.
      effective: teamId
        ? this.contract(applyWorkOverrides(inherited, overrides), rev)
        : await this.effectiveForMember(orgId, memberId, db),
      inherited: {
        ...this.contract(inherited, rev),
        ...(delegation ? { delegation } : {}),
      },
      organization: this.contract(org, rev),
      overrides,
      ...(teamId
        ? {
            finalEffective: await this.effectiveForMember(orgId, memberId, db),
          }
        : {}),
    };
  }
  private validate(input: WorkPolicyInput | WorkPolicyOverrides): void {
    validateWorkCatalog(input.managedCatalog);
    const seen = new Set<string>();
    const providers = new Set<string>();
    for (const p of input.providerModels) {
      if ("modelIds" in p && providers.has(p.providerId))
        throw new IdentityError(
          400,
          "duplicate_work_provider",
          "A Work provider may only appear once.",
        );
      providers.add(p.providerId);
      if (
        !workCatalog.items.some(
          (i) => i.type === "provider" && i.id === p.providerId,
        )
      )
        throw new IdentityError(
          400,
          "unknown_provider",
          "Unknown Work provider.",
        );
      for (const model of "modelIds" in p ? p.modelIds : [p.modelId]) {
        const key = `${p.providerId}\0${model}`;
        if (seen.has(key))
          throw new IdentityError(
            400,
            "duplicate_work_model",
            "Duplicate Work model assignment.",
          );
        seen.add(key);
      }
    }
  }
  /**
   * Team grants stay within the organization's approved delegation. A team
   * administrator is refused; an organization administrator's explicit team
   * grant approves those resources for team delegation (audited).
   */
  private async applyTeamDelegation(
    client: PoolClient,
    input: {
      actorId: string;
      actorRole: Role;
      input: WorkPolicyInput | WorkPolicyOverrides;
      memberId?: string;
      membershipId?: string;
      orgId: string;
      teamId: string;
    },
  ): Promise<void> {
    const org = await this.organization(input.orgId, client);
    const { stored, effective } = await this.delegation(input.orgId, client, org);
    const team = await this.teamPolicy(input.teamId, org, client);
    const before = input.memberId
      ? applyWorkOverrides(
          team,
          await this.overrides(input.memberId, input.membershipId, client),
        )
      : team;
    let next;
    if (input.memberId) {
      const overrides = input.input as WorkPolicyOverrides;
      next = {
        enabled: overrides.enabled,
        managedCatalog: overrides.managedCatalog,
        personalInstallations: overrides.personalInstallations,
        providerModels: overrides.providerModels
          .filter((model) => model.enabled)
          .map(({ modelId, providerId }) => ({ modelId, providerId })),
      };
    } else {
      const policy = input.input as WorkPolicyInput;
      next = {
        enabled: policy.enabled,
        managedCatalog: policy.managedCatalog,
        personalInstallations: policy.personalInstallations,
        providerModels: workModelRows(policy.providerModels),
      };
    }
    const excess = delegationExcess({
      ceiling: effective,
      next,
      previous: {
        enabled: before.enabled,
        managedCatalog: before.managedCatalog,
        personalInstallations: before.personalInstallations,
        providerModels: workModelRows(before.providerModels),
      },
    });
    if (!excess) return;
    if (!isOrganizationAdministrator(input.actorRole))
      throw delegationRefused(excess);
    const approved = approveWorkExcess(stored, excess);
    await client.query(
      "UPDATE organization_work_policies SET delegation=$2::jsonb WHERE organization_id=$1",
      [input.orgId, storedDocument(approved)],
    );
    await recordAuditEvent(client, {
      action: "organization.delegation_updated",
      actorUserId: input.actorId,
      organizationId: input.orgId,
      metadata: {
        approvedForTeamId: input.teamId,
        before: stored,
        after: approved,
        product: "work",
      },
      subjectId: input.orgId,
      subjectType: "organization",
    });
  }
  public async getDelegation(
    headers: IncomingHttpHeaders,
  ): Promise<WorkDelegationPolicy> {
    const orgId = (await this.identity.requireAdmin(headers)).organization.id;
    return this.readSnapshot(async (client) => {
      const { stored, effective } = await this.delegation(orgId, client);
      return { ...stored, effective, revision: await this.revision(orgId, client) };
    });
  }
  public async updateDelegation(
    headers: IncomingHttpHeaders,
    expectedRevision: number,
    input: unknown,
  ): Promise<WorkDelegationPolicy> {
    const next = normalizeWorkDelegation(WorkDelegationSchema.parse(input));
    this.validate({
      ...defaultWorkPolicy(),
      managedCatalog: next.managedCatalog.map((item) => ({ ...item, enabled: true })),
      providerModels: next.providerModels,
    });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const v = await this.identity.requireAdminForMutation(headers, client);
      const orgId = v.organization.id;
      if ((await this.revision(orgId, client)) !== expectedRevision)
        throw new IdentityError(
          409,
          "policy_revision_conflict",
          "Policy changed. Refresh and try again.",
        );
      const { stored } = await this.delegation(orgId, client);
      let revision = expectedRevision;
      if (JSON.stringify(stored) !== JSON.stringify(next)) {
        await client.query(
          "UPDATE organization_work_policies SET delegation=$2::jsonb WHERE organization_id=$1",
          [orgId, storedDocument(next)],
        );
        await client.query(
          "UPDATE organization_policies SET revision=revision+1,updated_at=NOW(),updated_by_user_id=$2 WHERE organization_id=$1",
          [orgId, v.user.id],
        );
        revision = expectedRevision + 1;
        await recordAuditEvent(client, {
          action: "organization.delegation_updated",
          actorUserId: v.user.id,
          organizationId: orgId,
          metadata: { after: next, before: stored, product: "work" },
          subjectId: orgId,
          subjectType: "organization",
        });
      }
      const { effective } = await this.delegation(orgId, client);
      await client.query("COMMIT");
      return { ...next, effective, revision };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  public async update(
    headers: IncomingHttpHeaders,
    scope: Scope,
    expectedRevision: number,
    input: WorkPolicyInput | WorkPolicyOverrides | null,
  ) {
    if (input) {
      input = scope.memberId
        ? WorkOverridesSchema.parse(input)
        : WorkPolicySchema.parse(input);
      this.validate(input);
    } else if (!scope.memberId) {
      throw new IdentityError(
        400,
        "invalid_work_reset",
        "Only member overrides can be reset.",
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let orgId: string;
      let actorId: string;
      let actorRole: Role;
      let teamId: string | undefined;
      if (scope.teamId) {
        const a = await this.teams.assertTeamAdmin(
          headers,
          scope.teamId,
          client,
        );
        orgId = a.actor.organization_id;
        actorId = a.actor.user_id;
        teamId = a.team.id;
        await client.query(
          "SELECT 1 FROM organization_policies WHERE organization_id=$1 FOR UPDATE",
          [orgId],
        );
        // Resolve a slug only once. A rename/replacement while this request
        // waits for the organization lock cannot authorize a different team.
        const b = await this.teams.assertTeamAdmin(headers, teamId, client);
        if (
          b.actor.user_id !== actorId ||
          b.actor.organization_id !== orgId ||
          b.team.id !== teamId
        )
          throw new IdentityError(403, "admin_required", "Access changed.");
        actorRole = b.actor.role;
      } else {
        const v = await this.identity.requireAdminForMutation(headers, client);
        orgId = v.organization.id;
        actorId = v.user.id;
        actorRole = v.role;
      }
      if ((await this.revision(orgId, client)) !== expectedRevision)
        throw new IdentityError(
          409,
          "policy_revision_conflict",
          "Policy changed. Refresh and try again.",
        );
      let key = orgId;
      let table = "organization_work_policies";
      let column = "organization_id";
      let payload = "policy";
      if (teamId) {
        key = teamId;
        table = "team_work_policies";
        column = "team_id";
      }
      if (scope.memberId) {
        await this.targetMember(orgId, scope.memberId, client);
        key = teamId
          ? await this.membership(teamId, scope.memberId, client)
          : scope.memberId;
        table = teamId
          ? "team_member_work_policy_overrides"
          : "member_work_policy_overrides";
        column = teamId ? "team_member_id" : "member_id";
        payload = "overrides";
      } else if (input && teamId) {
        const org = await this.organization(orgId, client);
        input = {
          ...input,
          forceAskMe: org.forceAskMe,
          memoryAllowed: org.memoryAllowed,
        };
      }
      if (input && teamId)
        await this.applyTeamDelegation(client, {
          actorId,
          actorRole,
          input,
          memberId: scope.memberId,
          membershipId: scope.memberId ? key : undefined,
          orgId,
          teamId,
        });
      if (input === null)
        await client.query(`DELETE FROM ${table} WHERE ${column}=$1`, [key]);
      else
        await client.query(
          `INSERT INTO ${table} (${column},${payload}) VALUES ($1,$2::jsonb) ON CONFLICT (${column}) DO UPDATE SET ${payload}=EXCLUDED.${payload}`,
          [key, JSON.stringify(input)],
        );
      await client.query(
        "UPDATE organization_policies SET revision=revision+1,updated_at=NOW(),updated_by_user_id=$2 WHERE organization_id=$1",
        [orgId, actorId],
      );
      await recordAuditEvent(client, {
        action: input ? "work.policy_updated" : "work.policy_reset",
        actorUserId: actorId,
        organizationId: orgId,
        subjectType: scope.memberId
          ? "member"
          : teamId
            ? "team"
            : "organization",
        subjectId: scope.memberId ?? teamId ?? orgId,
        metadata: { teamId: teamId ?? null, revision: expectedRevision + 1 },
      });
      await client.query("COMMIT");
      return this.read(
        headers,
        teamId ? { teamId, memberId: scope.memberId } : scope,
      );
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
