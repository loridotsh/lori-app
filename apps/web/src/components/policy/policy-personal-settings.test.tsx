import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TeamPolicy } from "@lori-enterprise/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PolicyPersonalSettings } from "./policy-personal-settings";

const teamPolicy: TeamPolicy = {
  managedCatalog: [],
  organizationPersonalInstallations: {
    plugins: false,
    providers: false,
    skills: true,
  },
  personalInstallations: {
    plugins: false,
    providers: false,
    skills: false,
  },
  revision: 21,
  updatedAt: "2026-07-31T09:00:00.000Z",
};

describe("PolicyPersonalSettings team attribution", () => {
  afterEach(() => vi.restoreAllMocks());
  it("explains that disabling a team grant does not revoke organization access", () => {
    render(
      <PolicyPersonalSettings
        initialTeamPolicy={teamPolicy}
        mode="team"
        teamId="team-1"
      />,
    );

    expect(
      screen.getByText(
        "Effective source: the organization still grants access.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Turning a setting off removes this team’s grant/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("switch", { name: "Enable Skills" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("previews team-wide consequences before applying a policy change", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) => {
        if (String(input).includes("/preview")) {
          return new Response(
            JSON.stringify({
              catalogGrantsAdded: 0,
              catalogGrantsRemoved: 0,
              personalGrantsAdded: 1,
              personalGrantsRemoved: 0,
              potentiallyAffectedMemberCount: 42,
              revision: 21,
            }),
          );
        }
        return new Response(
          JSON.stringify({
            ...teamPolicy,
            personalInstallations: {
              ...teamPolicy.personalInstallations,
              plugins: true,
            },
            revision: 22,
          }),
        );
      },
    );
    render(
      <PolicyPersonalSettings
        initialTeamPolicy={teamPolicy}
        mode="team"
        teamId="team-1"
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Enable Apps and plugins" }));
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));

    expect(
      await screen.findByRole("dialog", { name: "Review team policy changes" }),
    ).toBeTruthy();
    expect(screen.getByText(/Up to 42 team members/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
