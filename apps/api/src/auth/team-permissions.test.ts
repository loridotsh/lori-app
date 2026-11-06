import { describe, expect, it } from "vitest";
import {
  assertTeamRoleMutationAllowed,
  buildTeamPolicyPreview,
} from "./team-service.js";

describe("team administrator role safeguards", () => {
  it("keeps scoped team admins from delegating or revoking administrator access", () => {
    expect(() =>
      assertTeamRoleMutationAllowed("member", "member", "team_admin"),
    ).toThrowError(/organization administrator/i);
    expect(() =>
      assertTeamRoleMutationAllowed("member", "team_admin", "member"),
    ).toThrowError(/organization administrator/i);
    expect(() =>
      assertTeamRoleMutationAllowed("member", "team_admin", "remove"),
    ).toThrowError(/organization administrator/i);
  });

  it("allows scoped admins to manage regular members and org admins to manage roles", () => {
    expect(() =>
      assertTeamRoleMutationAllowed("member", "member", "member"),
    ).not.toThrow();
    expect(() =>
      assertTeamRoleMutationAllowed("member", "member", "remove"),
    ).not.toThrow();
    expect(() =>
      assertTeamRoleMutationAllowed("admin", "member", "team_admin"),
    ).not.toThrow();
    expect(() =>
      assertTeamRoleMutationAllowed("admin", "team_admin", "remove"),
    ).not.toThrow();
  });
});

describe("team policy preview", () => {
  it("summarizes direct grant changes without claiming downstream revocation", () => {
    expect(
      buildTeamPolicyPreview(
        {
          managedCatalog: [
            { enabled: true, id: "notion", type: "app" },
            { enabled: true, id: "openai", type: "provider" },
          ],
          organizationPersonalInstallations: {
            plugins: false,
            providers: false,
            skills: false,
          },
          personalInstallations: {
            plugins: true,
            providers: false,
            skills: false,
          },
          revision: 12,
          updatedAt: "2026-07-31T00:00:00.000Z",
        },
        {
          plugins: false,
          providers: true,
          skills: false,
        },
        [
          { enabled: true, id: "linear", type: "app" },
          { enabled: true, id: "openai", type: "provider" },
        ],
        42,
      ),
    ).toEqual({
      catalogGrantsAdded: 1,
      catalogGrantsRemoved: 1,
      personalGrantsAdded: 1,
      personalGrantsRemoved: 1,
      potentiallyAffectedMemberCount: 42,
      revision: 12,
    });
  });
});
