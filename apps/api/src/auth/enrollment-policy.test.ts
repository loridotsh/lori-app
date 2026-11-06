import { describe, expect, it } from "vitest";
import type { OrganizationPolicy } from "@lori-enterprise/contracts";
import {
  managedCatalogWithAttribution,
  memberPolicyOverridesChanged,
  organizationAssignments,
  resolveMemberPolicy,
  resolveTeamAwareMemberPolicy,
  validateCatalog,
} from "./enrollment-service.js";

const organization: OrganizationPolicy = {
  managedCatalog: [
    { enabled: true, id: "notion", type: "app" },
    { enabled: true, id: "openai", type: "provider" },
  ],
  personalInstallations: {
    plugins: false,
    providers: true,
    skills: false,
  },
  revision: 7,
  updatedAt: "2026-07-30T00:00:00.000Z",
};

describe("organization catalog assignment semantics", () => {
  it("keeps positive assignments and treats disabled rows as unassigned", () => {
    expect(
      organizationAssignments([
        { enabled: false, id: "linear", type: "app" },
        { enabled: true, id: "openai", type: "provider" },
        { enabled: true, id: "notion", type: "app" },
      ]),
    ).toEqual([
      { enabled: true, id: "notion", type: "app" },
      { enabled: true, id: "openai", type: "provider" },
    ]);
  });

  it("inherits every organization default when no member override exists", () => {
    expect(resolveMemberPolicy(organization, undefined, [])).toEqual(organization);
  });

  it("resolves allow, block, and inherit independently for every category", () => {
    expect(
      resolveMemberPolicy(
        organization,
        { plugins: true, providers: false, skills: null },
        [],
      ).personalInstallations,
    ).toEqual({
      plugins: true,
      providers: false,
      skills: false,
    });
  });

  it("lets member item decisions override organization assignments", () => {
    expect(
      resolveMemberPolicy(organization, undefined, [
        { enabled: false, id: "notion", type: "app" },
        { enabled: true, id: "linear", type: "app" },
      ]).managedCatalog,
    ).toEqual([
      { enabled: true, id: "linear", type: "app" },
      { enabled: false, id: "notion", type: "app" },
      { enabled: true, id: "openai", type: "provider" },
    ]);
  });

  it("does not mutate the organization policy while resolving a member", () => {
    const snapshot = structuredClone(organization);
    resolveMemberPolicy(
      organization,
      { plugins: true, providers: null, skills: null },
      [{ enabled: false, id: "notion", type: "app" }],
    );
    expect(organization).toEqual(snapshot);
  });

  it("rejects duplicate and unknown catalog identities", () => {
    expect(() =>
      validateCatalog([
        { enabled: true, id: "notion", type: "app" },
        { enabled: false, id: "notion", type: "app" },
      ]),
    ).toThrowError(/only appear once/i);
    expect(() =>
      validateCatalog([
        { enabled: true, id: "not-in-this-release", type: "skill" },
      ]),
    ).toThrowError(/not in this Lori release/i);
  });

  it("treats identical member saves as idempotent regardless of item order", () => {
    const current = {
      managedCatalog: [
        { enabled: false, id: "notion", type: "app" as const },
        { enabled: true, id: "openai", type: "provider" as const },
      ],
      personalInstallations: {
        plugins: true,
        providers: null,
        skills: false,
      },
    };
    expect(
      memberPolicyOverridesChanged(current, {
        ...current,
        managedCatalog: [...current.managedCatalog].reverse(),
      }),
    ).toBe(false);
    expect(
      memberPolicyOverridesChanged(current, {
        ...current,
        personalInstallations: {
          ...current.personalInstallations,
          skills: true,
        },
      }),
    ).toBe(true);
  });
});

describe("team-aware policy resolution", () => {
  it("explains every final catalog decision without losing contributing grants", () => {
    const frontend = { id: "team-frontend", name: "Frontend", slug: "frontend" };
    const platform = { id: "team-platform", name: "Platform", slug: "platform" };
    const resolved = managedCatalogWithAttribution(
      [{ enabled: true, id: "notion", type: "app" }],
      [
        { enabled: true, id: "linear", team: frontend, type: "app" },
        { enabled: true, id: "linear", team: platform, type: "app" },
        { enabled: true, id: "notion", team: platform, type: "app" },
      ],
      [
        { enabled: false, id: "notion", type: "app" },
        { enabled: true, id: "openai", type: "provider" },
      ],
    );

    expect(resolved.managedCatalog).toEqual([
      { enabled: true, id: "linear", type: "app" },
      { enabled: false, id: "notion", type: "app" },
      { enabled: true, id: "openai", type: "provider" },
    ]);
    expect(resolved.attribution).toEqual([
      {
        enabled: true,
        id: "linear",
        organizationAssigned: false,
        source: "team",
        teams: [frontend, platform],
        type: "app",
      },
      {
        enabled: false,
        id: "notion",
        memberOverride: false,
        organizationAssigned: true,
        source: "member_override",
        teams: [platform],
        type: "app",
      },
      {
        enabled: true,
        id: "openai",
        memberOverride: true,
        organizationAssigned: false,
        source: "member_override",
        teams: [],
        type: "provider",
      },
    ]);
  });

  it("is byte-for-byte equivalent for members with no team contributions", () => {
    expect(
      resolveTeamAwareMemberPolicy(
        organization,
        undefined,
        [],
        undefined,
        [],
      ),
    ).toEqual(organization);
  });

  it("unions disjoint and overlapping team catalog grants", () => {
    expect(
      resolveTeamAwareMemberPolicy(
        organization,
        { plugins: false, providers: false, skills: false },
        [
          { enabled: true, id: "linear", type: "app" },
          { enabled: true, id: "notion", type: "app" },
        ],
        undefined,
        [],
      ).managedCatalog,
    ).toEqual([
      { enabled: true, id: "linear", type: "app" },
      { enabled: true, id: "notion", type: "app" },
      { enabled: true, id: "openai", type: "provider" },
    ]);
  });

  it("uses least-restrictive personal access across organization and teams", () => {
    expect(
      resolveTeamAwareMemberPolicy(
        organization,
        { plugins: true, providers: false, skills: true },
        [],
        undefined,
        [],
      ).personalInstallations,
    ).toEqual({
      plugins: true,
      providers: true,
      skills: true,
    });
  });

  it("applies global member blocks after every organization and team grant", () => {
    expect(
      resolveTeamAwareMemberPolicy(
        organization,
        { plugins: true, providers: false, skills: true },
        [{ enabled: true, id: "linear", type: "app" }],
        { plugins: false, providers: null, skills: false },
        [
          { enabled: false, id: "linear", type: "app" },
          { enabled: false, id: "notion", type: "app" },
        ],
      ),
    ).toMatchObject({
      managedCatalog: [
        { enabled: false, id: "linear", type: "app" },
        { enabled: false, id: "notion", type: "app" },
        { enabled: true, id: "openai", type: "provider" },
      ],
      personalInstallations: {
        plugins: false,
        providers: true,
        skills: false,
      },
    });
  });

  it("ignores disabled team rows because team catalogs are additive grants", () => {
    expect(
      resolveTeamAwareMemberPolicy(
        organization,
        undefined,
        [{ enabled: false, id: "linear", type: "app" }],
        undefined,
        [],
      ).managedCatalog,
    ).toEqual(organization.managedCatalog);
  });
});
