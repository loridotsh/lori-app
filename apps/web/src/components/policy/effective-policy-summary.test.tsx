import type { OrganizationPolicy } from "@lori-enterprise/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EffectivePolicySummary } from "./effective-policy-summary";

const policy: OrganizationPolicy = {
  managedCatalog: [
    { enabled: true, id: "linear", type: "app" },
    { enabled: false, id: "notion", type: "app" },
  ],
  managedCatalogAttribution: [
    {
      enabled: true,
      id: "linear",
      organizationAssigned: false,
      source: "team",
      teams: [{ id: "team-1", name: "Frontend", slug: "frontend" }],
      type: "app",
    },
    {
      enabled: false,
      id: "notion",
      memberOverride: false,
      organizationAssigned: true,
      source: "member_override",
      teams: [{ id: "team-2", name: "Platform", slug: "platform" }],
      type: "app",
    },
  ],
  personalInstallations: { plugins: false, providers: true, skills: false },
  revision: 9,
  updatedAt: "2026-07-31T00:00:00.000Z",
};

describe("EffectivePolicySummary", () => {
  it("explains final catalog and personal access sources", () => {
    render(<EffectivePolicySummary policy={policy} />);

    expect(screen.getByText("Final effective access")).toBeTruthy();
    expect(screen.getByText("linear")).toBeTruthy();
    expect(screen.getByText("Granted by Frontend")).toBeTruthy();
    expect(screen.getByText("notion")).toBeTruthy();
    expect(
      screen.getByText("Blocked by member override; also assigned by Organization and Platform"),
    ).toBeTruthy();
    expect(screen.getByText("Personal AI providers")).toBeTruthy();
    expect(screen.getByText("Allowed")).toBeTruthy();
  });
});
