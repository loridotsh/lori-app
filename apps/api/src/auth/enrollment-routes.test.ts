import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnrollmentService } from "./enrollment-service.js";
import type { IdentityService } from "./identity-service.js";
import type { UsageAnalyticsService } from "../usage/service.js";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";
import {
  PolicyUpdateCapacityError,
  type DesktopPolicyUpdates,
  type DesktopUpdateNotification,
} from "./policy-updates.js";

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

function createApp(usageAnalytics?: UsageAnalyticsService) {
  const enrollment = {
    authorize: vi.fn(),
    bootstrap: vi.fn(async () => ({
      bootstrap: { protocolVersion: 1 },
      etag: '"lori-policy-v1-1"',
    })),
    disconnect: vi.fn(async () => undefined),
    currentPolicyRevision: vi.fn(async () => 1),
    desktopUpdateState: vi.fn(async () => ({
      deviceId: "5d6f332f-5bce-46dc-bbb4-a76d8ba72519",
      organizationId: "org-1",
      revision: 1,
    })),
    exchange: vi.fn(async () => ({
      accessToken: "lea_access",
      deviceId: "5d6f332f-5bce-46dc-bbb4-a76d8ba72519",
      expiresIn: 900,
      refreshExpiresIn: 2_592_000,
      refreshToken: "ler_refresh",
      tokenType: "Bearer",
    })),
    getCatalog: vi.fn(async () => ({ items: [] })),
    getMemberPolicy: vi.fn(),
    getOrganizationPolicy: vi.fn(async () => ({
      managedCatalog: [],
      personalInstallations: {
        plugins: false,
        providers: false,
        skills: false,
      },
      revision: 1,
      updatedAt: new Date().toISOString(),
    })),
    reportDesktopInventory: vi.fn(async () => undefined),
    getPolicy: vi.fn(),
    refresh: vi.fn(),
    resetMemberPolicy: vi.fn(),
    updateMemberPolicy: vi.fn(),
    updatePolicy: vi.fn(async () => ({
      managedCatalog: [],
      personalInstallations: {
        plugins: false,
        providers: true,
        skills: false,
      },
      revision: 4,
      updatedAt: new Date().toISOString(),
    })),
  } as unknown as EnrollmentService;
  const identity = {
    enforceRateLimit: vi.fn(async () => undefined),
  } as unknown as IdentityService;
  const policyUpdates: DesktopPolicyUpdates = {
    close: vi.fn(async () => undefined),
    snapshot: vi.fn(() => 0),
    waitForChange: vi.fn(
      async (): Promise<DesktopUpdateNotification | null> => null,
    ),
  };
  const app = buildApp({
    config,
    database: {
      check: async () => true,
      close: async () => undefined,
    },
    enrollment,
    identity,
    policyUpdates,
    usageAnalytics,
  });
  return { app, enrollment, policyUpdates };
}

const apps: ReturnType<typeof createApp>["app"][] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("desktop enrollment routes", () => {
  it("returns a changed policy revision immediately", async () => {
    const { app, enrollment, policyUpdates } = createApp();
    apps.push(app);
    vi.mocked(enrollment.desktopUpdateState).mockResolvedValue({
      deviceId: "5d6f332f-5bce-46dc-bbb4-a76d8ba72519",
      organizationId: "org-1",
      revision: 4,
    });

    const response = await app.inject({
      headers: {
        authorization: "Bearer lea_access",
        "x-lori-protocol-version": "1",
      },
      method: "GET",
      url: "/v1/desktop/updates?afterRevision=3",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({ reason: "policy", revision: 4 });
    expect(policyUpdates.waitForChange).not.toHaveBeenCalled();
  });

  it("waits for a committed policy notification without polling the database", async () => {
    const { app, policyUpdates } = createApp();
    apps.push(app);
    vi.mocked(policyUpdates.waitForChange).mockResolvedValue({
      deviceId: "*",
      kind: "policy",
      organizationId: "org-1",
      revision: 2,
      sequence: 1,
    });

    const response = await app.inject({
      headers: {
        authorization: "Bearer lea_access",
        "x-lori-protocol-version": "1",
      },
      method: "GET",
      url: "/v1/desktop/updates?afterRevision=1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reason: "policy", revision: 2 });
    expect(policyUpdates.waitForChange).toHaveBeenCalledWith(
      {
        deviceId: "5d6f332f-5bce-46dc-bbb4-a76d8ba72519",
        organizationId: "org-1",
      },
      0,
      25_000,
      expect.any(AbortSignal),
    );
  });

  it("returns no content when the live update wait expires", async () => {
    const { app } = createApp();
    apps.push(app);
    const response = await app.inject({
      headers: {
        authorization: "Bearer lea_access",
        "x-lori-protocol-version": "1",
      },
      method: "GET",
      url: "/v1/desktop/updates?afterRevision=1",
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
  });

  it("rate limits duplicate live waits without exposing an internal error", async () => {
    const { app, policyUpdates } = createApp();
    apps.push(app);
    vi.mocked(policyUpdates.waitForChange).mockRejectedValue(
      new PolicyUpdateCapacityError(),
    );
    const response = await app.inject({
      headers: {
        authorization: "Bearer lea_access",
        "x-lori-protocol-version": "1",
      },
      method: "GET",
      url: "/v1/desktop/updates?afterRevision=1",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.json()).toMatchObject({ error: "live_update_capacity" });
  });

  it("requires the current protocol version before exchanging a code", async () => {
    const { app, enrollment } = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      payload: {
        code: `lec_${"a".repeat(43)}`,
        codeVerifier: "b".repeat(43),
        protocolVersion: 2,
      },
      url: "/v1/enrollment/token",
    });

    expect(response.statusCode).toBe(426);
    expect(response.json()).toMatchObject({
      error: "unsupported_desktop_protocol",
    });
    expect(enrollment.exchange).not.toHaveBeenCalled();
  });

  it("returns enrollment credentials with no-store caching", async () => {
    const { app, enrollment } = createApp();
    apps.push(app);
    const payload = {
      code: `lec_${"a".repeat(43)}`,
      codeVerifier: "b".repeat(43),
      protocolVersion: 1,
    };
    const response = await app.inject({
      method: "POST",
      payload,
      url: "/v1/enrollment/token",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(enrollment.exchange).toHaveBeenCalledWith({
      code: payload.code,
      codeVerifier: payload.codeVerifier,
    });
  });

  it("rejects a refresh token in the authorization-code field", async () => {
    const { app, enrollment } = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      payload: {
        code: `ler_${"a".repeat(43)}`,
        codeVerifier: "b".repeat(43),
        protocolVersion: 1,
      },
      url: "/v1/enrollment/token",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });
    expect(enrollment.exchange).not.toHaveBeenCalled();
  });

  it("rejects browser enrollment approval from another origin", async () => {
    const { app, enrollment } = createApp();
    apps.push(app);
    const response = await app.inject({
      headers: { origin: "https://attacker.example" },
      method: "POST",
      payload: {
        appVersion: "1.0.0",
        codeChallenge: "a".repeat(43),
        deviceName: "Member laptop",
        platform: "macos",
        state: "b".repeat(22),
      },
      url: "/v1/enrollment/authorize",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "untrusted_origin" });
    expect(enrollment.authorize).not.toHaveBeenCalled();
  });

  it("rejects browser enrollment approval without origin evidence", async () => {
    const { app, enrollment } = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      payload: {
        appVersion: "1.0.0",
        codeChallenge: "a".repeat(43),
        deviceName: "Member laptop",
        platform: "macos",
        state: "b".repeat(22),
      },
      url: "/v1/enrollment/authorize",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "untrusted_origin" });
    expect(enrollment.authorize).not.toHaveBeenCalled();
  });

  it("accepts a same-origin Referer when Origin is unavailable", async () => {
    const { app, enrollment } = createApp();
    apps.push(app);
    const response = await app.inject({
      headers: { referer: `${config.publicUrl}/connect?request=test` },
      method: "POST",
      payload: {
        appVersion: "1.0.0",
        codeChallenge: "a".repeat(43),
        deviceName: "Member laptop",
        platform: "macos",
        state: "b".repeat(22),
      },
      url: "/v1/enrollment/authorize",
    });

    expect(response.statusCode).toBe(201);
    expect(enrollment.authorize).toHaveBeenCalledOnce();
  });

  it("accepts an exact loopback callback for development enrollment", async () => {
    const { app, enrollment } = createApp();
    apps.push(app);
    const callbackUrl = `http://127.0.0.1:49152/enroll/${"c".repeat(43)}`;
    const response = await app.inject({
      headers: { origin: config.publicUrl },
      method: "POST",
      payload: {
        appVersion: "1.5.4",
        callbackUrl,
        codeChallenge: "a".repeat(43),
        deviceName: "Lori on macOS",
        platform: "macos",
        state: "b".repeat(43),
      },
      url: "/v1/enrollment/authorize",
    });

    expect(response.statusCode).toBe(201);
    expect(enrollment.authorize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callbackUrl }),
    );
  });

  it.each([
    "https://127.0.0.1:49152/enroll/ccccccccccccccccccccccccccccccccccccccccccc",
    "http://localhost:49152/enroll/ccccccccccccccccccccccccccccccccccccccccccc",
    "http://127.0.0.1:49152/enroll/short",
    "http://127.0.0.1:49152/enroll/ccccccccccccccccccccccccccccccccccccccccccc?next=evil",
  ])("rejects an unsafe development callback: %s", async (callbackUrl) => {
    const { app, enrollment } = createApp();
    apps.push(app);
    const response = await app.inject({
      headers: { origin: config.publicUrl },
      method: "POST",
      payload: {
        appVersion: "1.5.4",
        callbackUrl,
        codeChallenge: "a".repeat(43),
        deviceName: "Lori on macOS",
        platform: "macos",
        state: "b".repeat(43),
      },
      url: "/v1/enrollment/authorize",
    });

    expect(response.statusCode).toBe(400);
    expect(enrollment.authorize).not.toHaveBeenCalled();
  });

  it("supports conditional desktop bootstrap responses", async () => {
    const { app, enrollment } = createApp();
    apps.push(app);
    const response = await app.inject({
      headers: {
        authorization: `Bearer lea_${"a".repeat(43)}`,
        "if-none-match": '"lori-policy-v1-1"',
        "x-lori-protocol-version": "1",
      },
      method: "GET",
      url: "/v1/desktop/bootstrap",
    });

    expect(response.statusCode).toBe(304);
    expect(response.headers.etag).toBe('"lori-policy-v1-1"');
    expect(enrollment.bootstrap).toHaveBeenCalledWith(
      `Bearer lea_${"a".repeat(43)}`,
    );
  });

  it("invalidates desktop bootstrap caches when a member collection epoch rotates", async () => {
    const desktopPolicy = vi.fn(async () => ({
      enabled: true,
      epoch: "00000000-0000-4000-8000-000000000001",
      startedAt: "2026-08-01T00:00:00.000Z",
    }));
    const usageAnalytics = {
      desktopPolicy,
      stopRetentionWorker: vi.fn(),
    } as unknown as UsageAnalyticsService;
    const { app } = createApp(usageAnalytics);
    apps.push(app);
    const headers = {
      authorization: `Bearer lea_${"a".repeat(43)}`,
      "x-lori-protocol-version": "1",
    };

    const first = await app.inject({ headers, method: "GET", url: "/v1/desktop/bootstrap" });
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).not.toBe('"lori-policy-v1-1"');
    expect(first.json()).toMatchObject({ usageAnalytics: { epoch: "00000000-0000-4000-8000-000000000001" } });

    const cached = await app.inject({
      headers: { ...headers, "if-none-match": first.headers.etag },
      method: "GET",
      url: "/v1/desktop/bootstrap",
    });
    expect(cached.statusCode).toBe(304);

    desktopPolicy.mockResolvedValue({
      enabled: true,
      epoch: "00000000-0000-4000-8000-000000000002",
      startedAt: "2026-08-11T00:00:00.000Z",
    });
    const rotated = await app.inject({
      headers: { ...headers, "if-none-match": first.headers.etag },
      method: "GET",
      url: "/v1/desktop/bootstrap",
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.headers.etag).not.toBe(first.headers.etag);
  });

  it("revokes the authenticated desktop session", async () => {
    const { app, enrollment } = createApp();
    apps.push(app);
    const authorization = `Bearer lea_${"a".repeat(43)}`;
    const response = await app.inject({
      headers: {
        authorization,
        "x-lori-protocol-version": "1",
      },
      method: "POST",
      url: "/v1/desktop/disconnect",
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(enrollment.disconnect).toHaveBeenCalledWith(authorization);
  });

  it("rejects desktop disconnects with an unsupported protocol", async () => {
    const { app, enrollment } = createApp();
    apps.push(app);
    const response = await app.inject({
      headers: {
        authorization: `Bearer lea_${"a".repeat(43)}`,
        "x-lori-protocol-version": "2",
      },
      method: "POST",
      url: "/v1/desktop/disconnect",
    });

    expect(response.statusCode).toBe(426);
    expect(enrollment.disconnect).not.toHaveBeenCalled();
  });

  it("validates and accepts a bounded desktop inventory report", async () => {
    const { app, enrollment } = createApp();
    apps.push(app);
    const payload = {
      items: [
        {
          enabled: true,
          enabledAgents: ["claude", "codex"],
          id: "frontend-design",
          name: "Frontend Design",
          organizationManaged: false,
          type: "skill",
        },
      ],
      policyRevision: 12,
      syncError: null,
      syncStatus: "synced",
    };
    const response = await app.inject({
      headers: {
        authorization: `Bearer lea_${"a".repeat(43)}`,
        "x-lori-protocol-version": "1",
      },
      method: "PUT",
      payload,
      url: "/v1/desktop/inventory",
    });

    expect(response.statusCode).toBe(204);
    expect(enrollment.reportDesktopInventory).toHaveBeenCalledWith(
      `Bearer lea_${"a".repeat(43)}`,
      payload,
    );
  });

  it("rejects duplicate inventory identities before replacing device state", async () => {
    const { app, enrollment } = createApp();
    apps.push(app);
    const item = {
      enabled: true,
      enabledAgents: ["codex"],
      id: "frontend-design",
      name: "Frontend Design",
      organizationManaged: false,
      type: "skill",
    };
    const response = await app.inject({
      headers: {
        authorization: `Bearer lea_${"a".repeat(43)}`,
        "x-lori-protocol-version": "1",
      },
      method: "PUT",
      payload: {
        items: [item, item],
        policyRevision: 12,
        syncError: null,
        syncStatus: "synced",
      },
      url: "/v1/desktop/inventory",
    });

    expect(response.statusCode).toBe(400);
    expect(enrollment.reportDesktopInventory).not.toHaveBeenCalled();
  });

  it("validates and forwards organization catalog policy changes", async () => {
    const { app, enrollment } = createApp();
    apps.push(app);
    const payload = {
      expectedRevision: 3,
      managedCatalog: [
        { enabled: true, id: "openai", type: "provider" },
      ],
      personalInstallations: {
        plugins: false,
        providers: true,
        skills: false,
      },
    };
    const response = await app.inject({
      headers: { origin: config.publicUrl },
      method: "PATCH",
      payload,
      url: "/v1/admin/policy",
    });

    expect(response.statusCode).toBe(200);
    expect(enrollment.updatePolicy).toHaveBeenCalledWith(
      expect.anything(),
      payload.expectedRevision,
      payload.personalInstallations,
      payload.managedCatalog,
    );
  });

  it("rejects ambiguous member catalog overrides before the service", async () => {
    const { app, enrollment } = createApp();
    apps.push(app);
    const response = await app.inject({
      headers: { origin: config.publicUrl },
      method: "PATCH",
      payload: {
        expectedRevision: 1,
        overrides: {
          managedCatalog: [
            { enabled: true, id: "openai", type: "unknown" },
          ],
          personalInstallations: {
            plugins: null,
            providers: null,
            skills: null,
          },
        },
      },
      url: "/v1/admin/members/member-1/policy",
    });

    expect(response.statusCode).toBe(400);
    expect(enrollment.updateMemberPolicy).not.toHaveBeenCalled();
  });
});
