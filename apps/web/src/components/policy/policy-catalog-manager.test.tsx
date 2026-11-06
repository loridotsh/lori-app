import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PolicyCatalog, TeamPolicy } from "@lori-enterprise/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PolicyCatalogManager } from "./policy-catalog-manager";

const catalog: PolicyCatalog = {
  items: [
    {
      description: "Team planning",
      featured: false,
      id: "notion",
      name: "Notion",
      requiresAuth: true,
      type: "app",
    },
  ],
};

const teamPolicy: TeamPolicy = {
  managedCatalog: [],
  organizationPersonalInstallations: {
    plugins: false,
    providers: false,
    skills: false,
  },
  personalInstallations: {
    plugins: false,
    providers: false,
    skills: false,
  },
  revision: 21,
  updatedAt: "2026-07-31T09:00:00.000Z",
};

describe("PolicyCatalogManager team review", () => {
  afterEach(() => vi.restoreAllMocks());

  it("previews team-wide catalog changes before publishing them", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) => {
        if (String(input).includes("/preview")) {
          return new Response(
            JSON.stringify({
              catalogGrantsAdded: 1,
              catalogGrantsRemoved: 0,
              personalGrantsAdded: 0,
              personalGrantsRemoved: 0,
              potentiallyAffectedMemberCount: 42,
              revision: 21,
            }),
          );
        }
        return new Response(
          JSON.stringify({
            ...teamPolicy,
            managedCatalog: [{ enabled: true, id: "notion", type: "app" }],
            revision: 22,
          }),
        );
      },
    );

    render(
      <PolicyCatalogManager
        catalog={catalog}
        catalogType="app"
        initialTeamPolicy={teamPolicy}
        mode="team"
        teamId="team-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Assign Notion" }));
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));

    expect(
      await screen.findByRole("dialog", { name: "Review team policy changes" }),
    ).toBeTruthy();
    expect(screen.getByText(/Up to 42 team members/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Apps assignments saved.")).toBeTruthy();
  });
});
