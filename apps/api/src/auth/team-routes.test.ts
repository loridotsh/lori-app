import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";
import type { IdentityService } from "./identity-service.js";
import type { TeamService } from "./team-service.js";

const config: AppConfig = {
  auth: {
    secret: "test-auth-secret-that-is-at-least-32-characters",
    secureCookies: false,
    setupToken: "test-setup-token-that-is-at-least-32-characters",
  },
  database: {
    host: "127.0.0.1",
    name: "unused",
    password: "test-database-password-at-least-32-characters",
    port: 1,
    ssl: false,
    user: "unused",
  },
  environment: "test",
  gateway: {
    secret: "test-provider-gateway-secret-at-least-32-characters",
  },
  host: "127.0.0.1",
  logLevel: "silent",
  port: 4000,
  publicUrl: "https://lori.acme.com",
  trustProxy: false,
  version: "test",
};

function createApp() {
  const teamService = {
    addTeamMember: vi.fn(async () => ({ memberId: "member-1" })),
    createTeam: vi.fn(async (_headers, input) => ({
      ...input,
      createdAt: new Date().toISOString(),
      id: "team-1",
      memberCount: 0,
      updatedAt: new Date().toISOString(),
    })),
    deleteTeam: vi.fn(),
    getTeam: vi.fn(async () => ({ id: "team-1" })),
    getTeamMemberPolicy: vi.fn(async () => ({ effective: {} })),
    getTeamPolicy: vi.fn(async () => ({ revision: 1 })),
    listEligibleTeamMembers: vi.fn(async () => ({ members: [] })),
    listTeamMembers: vi.fn(async () => ({ members: [] })),
    listTeams: vi.fn(async () => ({ teams: [] })),
    previewTeamPolicy: vi.fn(async () => ({ revision: 1 })),
    removeTeamMember: vi.fn(),
    resetTeamMemberPolicy: vi.fn(async () => ({ effective: {} })),
    updateTeam: vi.fn(async () => ({ id: "team-1" })),
    updateTeamMemberPolicy: vi.fn(async () => ({ effective: {} })),
    updateTeamMemberRole: vi.fn(async () => ({ memberId: "member-1" })),
    updateTeamPolicy: vi.fn(async () => ({ revision: 2 })),
    addTeamMembers: vi.fn(async () => ({ added: [], skippedMemberIds: [] })),
  } as unknown as TeamService;
  const identity = {
    enforceRateLimit: vi.fn(async () => undefined),
  } as unknown as IdentityService;
  const app = buildApp({
    config,
    database: {
      check: async () => true,
      close: async () => undefined,
    },
    identity,
    teamService,
  });
  return { app, identity, teamService };
}

const apps: ReturnType<typeof createApp>["app"][] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("team routes", () => {
  it("lists teams with private no-store caching", async () => {
    const { app, teamService } = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/teams",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(teamService.listTeams).toHaveBeenCalledOnce();
  });

  it("normalizes and forwards a valid create request", async () => {
    const { app, identity, teamService } = createApp();
    apps.push(app);
    const response = await app.inject({
      headers: { origin: config.publicUrl },
      method: "POST",
      payload: {
        description: " Platform ownership ",
        name: " Platform ",
        slug: "PLATFORM",
      },
      url: "/v1/admin/teams",
    });
    expect(response.statusCode).toBe(201);
    expect(teamService.createTeam).toHaveBeenCalledWith(
      expect.anything(),
      {
        description: "Platform ownership",
        name: "Platform",
        slug: "platform",
      },
    );
    expect(identity.enforceRateLimit).toHaveBeenCalledOnce();
  });

  it("rejects invalid slugs and empty patch requests before the service", async () => {
    const { app, teamService } = createApp();
    apps.push(app);
    const createResponse = await app.inject({
      headers: { origin: config.publicUrl },
      method: "POST",
      payload: { name: "Bad", slug: "bad slug" },
      url: "/v1/admin/teams",
    });
    const patchResponse = await app.inject({
      headers: { origin: config.publicUrl },
      method: "PATCH",
      payload: {},
      url: "/v1/teams/team-1",
    });
    expect(createResponse.statusCode).toBe(400);
    expect(patchResponse.statusCode).toBe(400);
    expect(teamService.createTeam).not.toHaveBeenCalled();
    expect(teamService.updateTeam).not.toHaveBeenCalled();
  });

  it("requires same-origin evidence for every mutation", async () => {
    const { app, teamService } = createApp();
    apps.push(app);
    const response = await app.inject({
      headers: { origin: "https://attacker.example" },
      method: "DELETE",
      url: "/v1/teams/team-1",
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "untrusted_origin" });
    expect(teamService.deleteTeam).not.toHaveBeenCalled();
  });

  it("forwards membership role changes and team policy writes", async () => {
    const { app, teamService } = createApp();
    apps.push(app);
    const roleResponse = await app.inject({
      headers: { origin: config.publicUrl },
      method: "PATCH",
      payload: { role: "team_admin" },
      url: "/v1/teams/team-1/members/team-member-1",
    });
    const policyPayload = {
      expectedRevision: 4,
      managedCatalog: [{ enabled: true, id: "notion", type: "app" }],
      personalInstallations: {
        plugins: true,
        providers: false,
        skills: false,
      },
    };
    const policyResponse = await app.inject({
      headers: { origin: config.publicUrl },
      method: "PATCH",
      payload: policyPayload,
      url: "/v1/teams/team-1/policy",
    });
    expect(roleResponse.statusCode).toBe(200);
    expect(teamService.updateTeamMemberRole).toHaveBeenCalledWith(
      expect.anything(),
      "team-1",
      "team-member-1",
      "team_admin",
    );
    expect(policyResponse.statusCode).toBe(200);
    expect(teamService.updateTeamPolicy).toHaveBeenCalledWith(
      expect.anything(),
      "team-1",
      4,
      policyPayload.personalInstallations,
      policyPayload.managedCatalog,
    );
  });

  it("forwards bounded list queries and bulk member additions", async () => {
    const { app, teamService } = createApp();
    apps.push(app);
    const listResponse = await app.inject({
      method: "GET",
      url: "/v1/teams/team-1/members?q=ash&limit=25&offset=50",
    });
    const bulkResponse = await app.inject({
      headers: { origin: config.publicUrl },
      method: "POST",
      payload: {
        memberIds: ["member-1", "member-2", "member-1"],
        role: "member",
      },
      url: "/v1/teams/team-1/members/bulk",
    });

    expect(listResponse.statusCode).toBe(200);
    expect(teamService.listTeamMembers).toHaveBeenCalledWith(
      expect.anything(),
      "team-1",
      { limit: 25, offset: 50, query: "ash" },
    );
    expect(bulkResponse.statusCode).toBe(201);
    expect(teamService.addTeamMembers).toHaveBeenCalledWith(
      expect.anything(),
      "team-1",
      ["member-1", "member-2", "member-1"],
      "member",
    );
  });

  it("forwards team-member override updates and resets", async () => {
    const { app, teamService } = createApp();
    apps.push(app);
    const overrides = {
      managedCatalog: [{ enabled: false, id: "notion", type: "app" }],
      personalInstallations: {
        plugins: null,
        providers: false,
        skills: true,
      },
    };
    const update = await app.inject({
      headers: { origin: config.publicUrl },
      method: "PATCH",
      payload: { expectedRevision: 8, overrides },
      url: "/v1/teams/team-1/members/member-1/policy",
    });
    const reset = await app.inject({
      headers: { origin: config.publicUrl },
      method: "DELETE",
      url: "/v1/teams/team-1/members/member-1/policy?expectedRevision=9",
    });
    expect(update.statusCode).toBe(200);
    expect(teamService.updateTeamMemberPolicy).toHaveBeenCalledWith(
      expect.anything(),
      "team-1",
      "member-1",
      8,
      overrides,
    );
    expect(reset.statusCode).toBe(200);
    expect(teamService.resetTeamMemberPolicy).toHaveBeenCalledWith(
      expect.anything(),
      "team-1",
      "member-1",
      9,
    );
  });
});
