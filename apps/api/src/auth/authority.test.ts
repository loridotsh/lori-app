import {
  delegationApproves,
  legacyOrganizationRole,
  membershipChangeDenial,
  organizationCapabilities,
  resolveProjectPolicy,
  type EnterpriseWorkPolicy,
  type ProjectPolicy,
} from "@lori-enterprise/contracts";
import { describe, expect, it } from "vitest";
import { assertInvitationAllowed, assertMembershipChange } from "./authority.js";
import {
  boundWorkContribution,
  delegationExcess,
  effectiveCodeDelegation,
  effectiveWorkDelegation,
  storedCodeDelegation,
  storedDocument,
  storedWorkDelegation,
} from "./delegation.js";
import { defaultWorkPolicy, emptyWorkOverrides } from "./work-service.js";
import { WorkResourceScope } from "./work-resources.js";
import { resolveProjectAccess } from "../cloud/projects/policy.js";
import { DEFAULT_PROJECT_POLICY } from "../cloud/projects/policy.js";

describe("organization authority", () => {
  it("gives Owner and Admin full operations and reserves appointments for the Owner", () => {
    expect(organizationCapabilities("owner")).toContain("admins.manage");
    expect(organizationCapabilities("owner")).toContain("ownership.transfer");
    expect(organizationCapabilities("admin")).not.toContain("admins.manage");
    expect(organizationCapabilities("admin")).toContain("projects.administer");
    expect(organizationCapabilities("member")).toEqual([]);
  });

  it("keeps older desktops on the roles they understand", () => {
    expect(legacyOrganizationRole("owner")).toBe("admin");
    expect(legacyOrganizationRole("admin")).toBe("admin");
    expect(legacyOrganizationRole("member")).toBe("member");
  });

  it.each([
    ["admin", "member", "admin", false, "owner_required"],
    ["admin", "admin", "member", false, "owner_required"],
    ["admin", "admin", "remove", false, "owner_required"],
    ["admin", "owner", "member", false, "owner_protected"],
    ["owner", "owner", "member", true, "self_change"],
    ["admin", "admin", "member", true, "self_change"],
    ["member", "member", "member", false, "admin_required"],
    ["owner", "admin", "member", false, null],
    ["owner", "member", "admin", false, null],
    ["admin", "member", "remove", false, null],
  ] as const)("%s changing a %s to %s (self=%s) → %s", (actorRole, targetRole, nextRole, self, expected) => {
    expect(membershipChangeDenial({ actorRole, targetRole, nextRole, self })).toBe(expected);
  });

  it("throws the matching API errors", () => {
    expect(() => assertInvitationAllowed("admin", "admin")).toThrowError(expect.objectContaining({ code: "owner_required" }));
    expect(() => assertInvitationAllowed("admin", "member")).not.toThrow();
    expect(() => assertInvitationAllowed("member", "member")).toThrowError(expect.objectContaining({ code: "admin_required" }));
    expect(() => assertMembershipChange({ actorRole: "admin", targetRole: "owner", nextRole: "remove", self: false })).toThrowError(expect.objectContaining({ code: "owner_protected", statusCode: 409 }));
  });
});

describe("delegation ceiling", () => {
  const organization = { ...defaultWorkPolicy(), enabled: false, personalInstallations: { plugins: false, providers: false, skills: false } };
  const ceiling = effectiveWorkDelegation(
    storedWorkDelegation({ version: 1, enabled: true, personalInstallations: { plugins: false, providers: false, skills: false }, managedCatalog: [{ type: "provider", id: "openai" }], providerModels: [{ providerId: "openai", modelIds: ["approved"] }] }),
    organization,
  );

  it("fails closed for missing or corrupt stored approvals", () => {
    expect(storedWorkDelegation(null)).toMatchObject({ enabled: false, providerModels: [] });
    expect(storedWorkDelegation({ version: 2, enabled: true })).toMatchObject({ enabled: false });
  });

  it("removes team grants outside the ceiling from the effective result", () => {
    const bounded = boundWorkContribution(
      { ...organization, enabled: true, managedCatalog: [{ type: "provider", id: "openai", enabled: true }, { type: "plugin", id: "notion", enabled: true }], providerModels: [{ providerId: "openai", modelIds: ["approved", "other"] }] },
      ceiling,
    );
    expect(bounded.providerModels).toEqual([{ providerId: "openai", modelIds: ["approved"] }]);
    expect(bounded.managedCatalog).toEqual([{ type: "provider", id: "openai", enabled: true }]);
  });

  it("lets teams assign plugins and skills everyone may already install, except ones the org turned off", () => {
    const open = effectiveWorkDelegation(storedWorkDelegation(null), {
      ...defaultWorkPolicy(),
      managedCatalog: [{ type: "skill", id: "pdfs", enabled: false }],
    });
    expect(delegationApproves(open, { type: "plugin", id: "notion" })).toBe(true);
    expect(delegationApproves(open, { type: "skill", id: "research" })).toBe(true);
    expect(delegationApproves(open, { type: "skill", id: "pdfs" })).toBe(false);
    expect(delegationApproves(open, { type: "provider", id: "openai" })).toBe(false);
    expect(delegationExcess({ ceiling: open, next: { managedCatalog: [{ type: "skill", id: "pdfs", enabled: true }] } })?.managedCatalog).toEqual([{ type: "skill", id: "pdfs" }]);
  });

  it("keeps Code items the organization turned off out of team reach", () => {
    const code = effectiveCodeDelegation(storedCodeDelegation(null), {
      personalInstallations: { plugins: true, providers: false, skills: true },
      managedCatalog: [{ type: "plugin", id: "blocked", enabled: false }],
    });
    expect(delegationApproves(code, { type: "plugin", id: "other" })).toBe(true);
    expect(delegationApproves(code, { type: "plugin", id: "blocked" })).toBe(false);
    expect(delegationExcess({ ceiling: code, next: { managedCatalog: [{ type: "plugin", id: "blocked", enabled: true }] } })?.managedCatalog).toEqual([{ type: "plugin", id: "blocked" }]);
  });

  it("refuses to store approvals the reader would reject, instead of failing closed later", () => {
    const many = Array.from({ length: 4097 }, (_, index) => `model-${index}`);
    expect(() => storedDocument({ enabled: true, personalInstallations: { plugins: false, providers: false, skills: false }, managedCatalog: [], providerModels: [{ providerId: "openai", modelIds: many }] })).toThrowError(expect.objectContaining({ code: "delegation_limit_reached" }));
    const fits = { enabled: true, personalInstallations: { plugins: false, providers: false, skills: false }, managedCatalog: [], providerModels: [{ providerId: "openai", modelIds: many.slice(0, 200) }] };
    expect(storedWorkDelegation(JSON.parse(storedDocument(fits)))).toEqual(fits);
    expect(JSON.parse(storedDocument({ ...fits, blockedCatalog: [{ type: "skill", id: "pdfs" }] }))).not.toHaveProperty("blockedCatalog");
  });

  it("refuses only new grants beyond the ceiling", () => {
    expect(delegationExcess({ ceiling, next: { providerModels: [{ providerId: "openai", modelId: "approved" }] } })).toBeNull();
    expect(delegationExcess({ ceiling, next: { providerModels: [{ providerId: "openai", modelId: "other" }] } })?.providerModels).toEqual([{ providerId: "openai", modelId: "other" }]);
    expect(delegationExcess({ ceiling, previous: { providerModels: [{ providerId: "openai", modelId: "other" }] }, next: { providerModels: [{ providerId: "openai", modelId: "other" }] } })).toBeNull();
  });
});

describe("project resource scope", () => {
  const policy = (models: string[]): EnterpriseWorkPolicy => ({ ...defaultWorkPolicy(), schemaVersion: 1, revision: 1, managedCatalog: models.length ? [{ type: "provider", id: "openai", enabled: true }] : [], providerModels: models.length ? [{ providerId: "openai", modelIds: models }] : [] });
  const approved = { enabled: true, personalInstallations: { plugins: true, providers: false, skills: true }, managedCatalog: [{ type: "provider" as const, id: "openai" }], providerModels: [{ providerId: "openai", modelIds: ["assigned", "general"] }] };
  const assigned = { ...DEFAULT_PROJECT_POLICY, providerMode: "assigned" as const, providerModels: [{ providerId: "openai", modelIds: ["assigned"] }], pluginMode: "assigned" as const, pluginIds: ["notion"] };
  const scope = (project: ProjectPolicy = assigned, memberOverrides = emptyWorkOverrides(), administrator = false, models = ["general"]) =>
    new WorkResourceScope({ administrator, approved, memberOverrides, organization: defaultWorkPolicy(), policy: policy(models), project });

  it("makes assigned resources usable inside the project without a general assignment", () => {
    const inProject = scope(assigned, emptyWorkOverrides(), false, []);
    expect(inProject.models("openai")).toEqual(["assigned"]);
    expect(inProject.model("openai", "assigned")).toEqual({ allowed: true, source: "project_assignment" });
    expect(inProject.model("openai", "general")).toEqual({ allowed: false, reason: "not_assigned_to_project" });
    expect(inProject.extension("plugin", "notion").allowed).toBe(true);
    expect(inProject.extension("plugin", "linear")).toEqual({ allowed: false, reason: "not_assigned_to_project" });
  });

  it("never applies project grants outside the project", () => {
    const outside = new WorkResourceScope({ administrator: false, approved, memberOverrides: emptyWorkOverrides(), organization: defaultWorkPolicy(), policy: policy([]) });
    expect(outside.models("openai")).toEqual([]);
  });

  it("keeps explicit member restrictions for members but not administrators", () => {
    const denials = { ...emptyWorkOverrides(), providerModels: [{ providerId: "openai", modelId: "assigned", enabled: false }] };
    expect(scope(assigned, denials).model("openai", "assigned")).toEqual({ allowed: false, reason: "member_restricted" });
    expect(scope(assigned, denials, true).model("openai", "assigned").allowed).toBe(true);
  });

  it("treats legacy nonempty lists as assignments and empty lists as inheritance", () => {
    expect(resolveProjectPolicy({ ...DEFAULT_PROJECT_POLICY, providerMode: undefined, providerModels: [{ providerId: "openai", modelIds: ["x"] }] }).providerMode).toBe("assigned");
    expect(resolveProjectPolicy({ ...DEFAULT_PROJECT_POLICY, providerMode: undefined }).providerMode).toBe("inherit");
    const { providerMode: _p, pluginMode: _g, skillMode: _s, ...legacy } = DEFAULT_PROJECT_POLICY;
    expect(scope(legacy as ProjectPolicy).models("openai")).toEqual(["general"]);
    expect(scope({ ...legacy, providerModels: [{ providerId: "openai", modelIds: ["assigned"] }] } as ProjectPolicy, emptyWorkOverrides(), false, []).models("openai")).toEqual(["assigned"]);
  });
});

describe("shared project access for administrators", () => {
  const base = { grants: [], blocked: true, policy: { ...DEFAULT_PROJECT_POLICY, exportsAllowed: false }, status: "active" as const, accessRevision: 1 };
  it("grants administrators full access despite blocks while keeping safety controls", () => {
    const access = resolveProjectAccess({ ...base, administrator: true });
    expect(access.source).toBe("organization_admin");
    expect(access.actions).toContain("members.manage");
    expect(access.actions).not.toContain("export");
    expect(access.actions).not.toContain("tools.write");
    expect(resolveProjectAccess(base).actions).toEqual([]);
  });
  it("still respects the project lifecycle", () => {
    expect(resolveProjectAccess({ ...base, administrator: true, status: "archived" }).actions).toEqual(["read"]);
    expect(resolveProjectAccess({ ...base, administrator: true, status: "deleted" }).actions).toEqual([]);
  });
});
