import type { Viewer } from "@lori-enterprise/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamMembersManager } from "./team-members-manager";

const admin: Viewer = {
  organization: { id: "org-1", name: "Acme" },
  role: "admin",
  user: { email: "admin@example.com", id: "user-1", name: "Admin" },
};
const team = {
  createdAt: "2026-07-31T00:00:00.000Z",
  id: "team-1",
  memberCount: 1,
  name: "Frontend",
  slug: "frontend",
  updatedAt: "2026-07-31T00:00:00.000Z",
};
const eligible = {
  members: [
    {
      createdAt: "2026-07-31T00:00:00.000Z",
      email: "ash@example.com",
      memberId: "member-1",
      name: "Ash",
      role: "member" as const,
      userId: "user-2",
    },
    {
      createdAt: "2026-07-31T00:00:00.000Z",
      email: "sam@example.com",
      memberId: "member-2",
      name: "Sam",
      role: "member" as const,
      userId: "user-3",
    },
  ],
  pageInfo: { hasMore: false, limit: 50, offset: 0, total: 2 },
};

afterEach(() => vi.restoreAllMocks());

describe("TeamMembersManager", () => {
  it("bulk-adds selected members and reserves team-admin grants for org admins", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, _init) => {
        const path = String(input);
        if (path.includes("/members/bulk")) {
          return new Response(
            JSON.stringify({ added: [], skippedMemberIds: [] }),
            { status: 201 },
          );
        }
        if (path.includes("eligible-members")) {
          return new Response(JSON.stringify({ members: [], pageInfo: eligible.pageInfo }));
        }
        return new Response(
          JSON.stringify({ members: [], pageInfo: eligible.pageInfo }),
        );
      },
    );

    render(
      <TeamMembersManager
        initialEligible={eligible}
        initialMembers={{ members: [], pageInfo: eligible.pageInfo }}
        team={team}
        viewer={admin}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Ash/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Sam/ }));
    expect(screen.getByRole("option", { name: "Team admin" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add 2 members" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/teams/team-1/members/bulk",
        expect.objectContaining({
          body: JSON.stringify({
            memberIds: ["member-1", "member-2"],
            role: "member",
          }),
          method: "POST",
        }),
      ),
    );
  });

  it("does not expose administrator-role controls to a scoped team admin", () => {
    render(
      <TeamMembersManager
        initialEligible={eligible}
        initialMembers={{ members: [], pageInfo: eligible.pageInfo }}
        team={team}
        viewer={{ ...admin, role: "member", teamAdmin: true }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    expect(screen.queryByRole("option", { name: "Team admin" })).toBeNull();
  });
});
