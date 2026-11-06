import type { Team, Viewer } from "@lori-enterprise/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamsManager } from "@/app/teams/teams-manager";

const viewer: Viewer = {
  organization: { id: "org-1", name: "Acme" },
  role: "admin",
  user: {
    email: "admin@example.com",
    id: "user-1",
    name: "Admin User",
  },
};

const team: Team = {
  createdAt: "2026-07-31T00:00:00.000Z",
  description: "Shared platform ownership",
  id: "team-1",
  memberCount: 3,
  name: "Platform",
  slug: "platform",
  updatedAt: "2026-07-31T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TeamsManager", () => {
  it("guides an administrator through creating the first team", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          ...team,
          description: "Owns shared developer infrastructure.",
          memberCount: 0,
          name: "Platform Engineering",
          slug: "platform-engineering",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 201,
        },
      ),
    );
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();

    render(<TeamsManager initialTeams={{ teams: [] }} viewer={viewer} />);
    expect(screen.getByText("Create your first team")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Create first team" }),
    );
    await user.type(screen.getByLabelText("Team name"), "Platform Engineering");
    expect(screen.getByLabelText("URL slug")).toHaveProperty(
      "value",
      "platform-engineering",
    );
    await user.type(
      screen.getByLabelText(/Description/),
      "Owns shared developer infrastructure.",
    );
    await user.click(screen.getByRole("button", { name: "Create team" }));

    await screen.findByText("Platform Engineering");
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe("/api/v1/admin/teams");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      name: "Platform Engineering",
      slug: "platform-engineering",
    });
  });

  it("uses a destructive confirmation before deleting a team", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();

    render(
      <TeamsManager initialTeams={{ teams: [team] }} viewer={viewer} />,
    );
    await user.click(
      screen.getByRole("button", { name: "Delete Platform" }),
    );
    expect(screen.getByText("Delete Platform?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete team" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("link", { name: /Manage/ }),
      ).toBeNull();
    });
    expect(request).toHaveBeenCalledWith(
      "/api/v1/teams/team-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("keeps organization-only actions out of scoped team-admin UI", () => {
    render(
      <TeamsManager
        initialTeams={{ teams: [team] }}
        viewer={{ ...viewer, role: "member", teamAdmin: true }}
      />,
    );
    expect(screen.queryByRole("button", { name: "New team" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete Platform" }),
    ).toBeNull();
    expect(screen.getByRole("link", { name: /Manage/ })).toBeTruthy();
  });
});
