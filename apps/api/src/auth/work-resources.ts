import {
  delegationApproves,
  resolveProjectPolicy,
  type EffectiveWorkDelegation,
  type EnterpriseWorkPolicy,
  type ProjectPolicy,
  type WorkPolicyInput,
  type WorkPolicyOverrides,
  type WorkResourceDenialReason,
} from "@lori-enterprise/contracts";

/**
 * Why a Work resource is unavailable in a scope. Shown to members as an
 * actionable explanation, and used by every enforcement path.
 */
export type WorkResourceDenial = Exclude<WorkResourceDenialReason, "not_connected">;

export interface WorkResourceDecision {
  allowed: boolean;
  reason?: WorkResourceDenial;
  /** Where an allowed resource comes from. */
  source?: "member_policy" | "project_assignment" | "organization_admin";
}

export interface WorkResourceScopeInput {
  /** The member's effective Work policy (administrator-aware). */
  policy: EnterpriseWorkPolicy;
  administrator: boolean;
  /** Organization-approved resources: delegation approvals plus defaults. */
  approved: EffectiveWorkDelegation;
  organization: WorkPolicyInput;
  /** Organization-level member overrides; their explicit denials always hold. */
  memberOverrides: WorkPolicyOverrides;
  /** Set only inside a shared project. Private chats never see project grants. */
  project?: ProjectPolicy;
}

const allow = (
  source: WorkResourceDecision["source"],
): WorkResourceDecision => ({ allowed: true, source });
const deny = (reason: WorkResourceDenial): WorkResourceDecision => ({
  allowed: false,
  reason,
});

/**
 * The one decision for Work providers, models, plugins and skills in a
 * scope. "inherit" uses the member's assignments; "assigned" makes exactly the
 * project's resources usable there, bounded by organization approval and the
 * member's explicit restrictions (administrators are not reduced by those).
 */
export class WorkResourceScope {
  private readonly project;
  constructor(private readonly input: WorkResourceScopeInput) {
    this.project = input.project ? resolveProjectPolicy(input.project) : undefined;
  }

  get policy(): EnterpriseWorkPolicy {
    return this.input.policy;
  }

  get administrator(): boolean {
    return this.input.administrator;
  }

  private memberSource(): WorkResourceDecision["source"] {
    return this.input.administrator ? "organization_admin" : "member_policy";
  }

  private explicitlyDenied(kind: "plugin" | "provider" | "skill", id: string) {
    if (this.input.administrator) return false;
    return this.input.memberOverrides.managedCatalog.some(
      (item) => item.type === kind && item.id === id && !item.enabled,
    );
  }

  private modelExplicitlyDenied(providerId: string, modelId: string) {
    if (this.input.administrator) return false;
    return this.input.memberOverrides.providerModels.some(
      (model) =>
        model.providerId === providerId &&
        model.modelId === modelId &&
        !model.enabled,
    );
  }

  private approvedExtension(kind: "plugin" | "skill", id: string): boolean {
    return delegationApproves(this.input.approved, { id, type: kind });
  }

  private approvedModel(providerId: string, modelId: string): boolean {
    return (
      this.input.approved.managedCatalog.some(
        (item) => item.type === "provider" && item.id === providerId,
      ) &&
      this.input.approved.providerModels.some(
        (row) => row.providerId === providerId && row.modelIds.includes(modelId),
      )
    );
  }

  /** Models of a provider usable in this scope. */
  models(providerId: string): string[] {
    const policy = this.input.policy;
    if (!policy.enabled) return [];
    if (this.project?.providerMode === "assigned") {
      const assigned =
        this.project.providerModels.find((row) => row.providerId === providerId)
          ?.modelIds ?? [];
      if (this.explicitlyDenied("provider", providerId)) return [];
      return assigned.filter(
        (model) =>
          this.approvedModel(providerId, model) &&
          !this.modelExplicitlyDenied(providerId, model),
      );
    }
    const enabled = policy.managedCatalog.some(
      (item) => item.type === "provider" && item.id === providerId && item.enabled,
    );
    if (!enabled) return [];
    return (
      policy.providerModels.find((row) => row.providerId === providerId)
        ?.modelIds ?? []
    );
  }

  model(providerId: string, modelId: string): WorkResourceDecision {
    if (!this.input.policy.enabled) return deny("work_disabled");
    if (this.project?.providerMode === "assigned") {
      const assigned = this.project.providerModels.some(
        (row) => row.providerId === providerId && row.modelIds.includes(modelId),
      );
      if (!assigned) return deny("not_assigned_to_project");
      if (!this.approvedModel(providerId, modelId)) return deny("not_approved");
      if (
        this.explicitlyDenied("provider", providerId) ||
        this.modelExplicitlyDenied(providerId, modelId)
      )
        return deny("member_restricted");
      return allow("project_assignment");
    }
    return this.models(providerId).includes(modelId)
      ? allow(this.memberSource())
      : deny("not_assigned");
  }

  extension(kind: "plugin" | "skill", id: string): WorkResourceDecision {
    if (!this.input.policy.enabled) return deny("work_disabled");
    const mode =
      kind === "plugin" ? this.project?.pluginMode : this.project?.skillMode;
    if (this.project && mode === "assigned") {
      const ids = kind === "plugin" ? this.project.pluginIds : this.project.skillIds;
      if (!ids.includes(id)) return deny("not_assigned_to_project");
      if (!this.approvedExtension(kind, id)) return deny("not_approved");
      if (this.explicitlyDenied(kind, id)) return deny("member_restricted");
      return allow("project_assignment");
    }
    const policy = this.input.policy;
    const managed = policy.managedCatalog.find(
      (item) => item.type === kind && item.id === id,
    );
    const allowed = managed
      ? managed.enabled
      : policy.personalInstallations[kind === "plugin" ? "plugins" : "skills"];
    return allowed ? allow(this.memberSource()) : deny("not_assigned");
  }
}
