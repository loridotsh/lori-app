import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { IdentityService } from "../auth/identity-service.js";
import { buildApp } from "../app.js";
import type { UsageAnalyticsService } from "./service.js";

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
  gateway: { secret: "test-provider-gateway-secret-at-least-32-characters" },
  host: "127.0.0.1",
  logLevel: "silent",
  port: 4000,
  publicUrl: "https://lori.acme.com",
  trustProxy: false,
  version: "test",
};

function snapshot(index = 0) {
  return {
    agentId: "codex",
    appVersion: "1.5.4",
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    costCoveredTokens: 100,
    estimatedCostMicrousd: 250,
    inputTokens: 10,
    model: `gpt-${index}`,
    outputTokens: 20,
    pricingVersion: "lori-2026-06",
    totalTurns: 1,
    usageDate: "2026-08-11",
  };
}

function createApp() {
  const identity = {
    enforceRateLimit: vi.fn(async () => undefined),
    setupStatus: vi.fn(async () => ({ state: "ready" })),
  } as unknown as IdentityService;
  const usage = {
    adminAnalytics: vi.fn(),
    analyticsCsv: vi.fn(() => "Period,Tokens\n2026-08-11,100"),
    deleteUsage: vi.fn(),
    ingest: vi.fn(async (_authorization, batch) => ({
      accepted: batch.snapshots.length,
      receivedAt: "2026-08-11T00:00:00.000Z",
    })),
    memberVisibility: vi.fn(),
    members: vi.fn(),
    ownAnalytics: vi.fn(),
    setMemberVisibility: vi.fn(),
    settings: vi.fn(),
    stopRetentionWorker: vi.fn(),
    updateSettings: vi.fn(),
  } as unknown as UsageAnalyticsService;
  const app = buildApp({
    config,
    database: { check: async () => true, close: async () => undefined },
    identity,
    usageAnalytics: usage,
  });
  return { app, identity, usage };
}

const apps: ReturnType<typeof createApp>["app"][] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("usage analytics routes", () => {
  it("advertises the capability only when the service is registered", async () => {
    const { app } = createApp();
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/v1/system/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json().capabilities.usageAnalytics).toBe(true);
  });

  it("derives desktop authority from the bearer token and accepts bounded snapshots", async () => {
    const { app, usage } = createApp();
    apps.push(app);
    const response = await app.inject({
      headers: { authorization: "Bearer lea_device" },
      method: "POST",
      payload: {
        epoch: "00000000-0000-4000-8000-000000000001",
        snapshots: [snapshot()],
        sourceId: "00000000-0000-4000-8000-000000000002",
      },
      url: "/v1/desktop/usage",
    });
    expect(response.statusCode).toBe(200);
    expect(usage.ingest).toHaveBeenCalledWith(
      "Bearer lea_device",
      expect.objectContaining({ snapshots: [expect.objectContaining({ agentId: "codex" })] }),
    );
  });

  it("rejects oversized batches and control-bearing labels before service execution", async () => {
    const { app, usage } = createApp();
    apps.push(app);
    for (const snapshots of [
      Array.from({ length: 251 }, (_, index) => snapshot(index)),
      [{ ...snapshot(), model: "unsafe\nmodel" }],
      [{ ...snapshot(), costCoveredTokens: 101 }],
    ]) {
      const response = await app.inject({
        method: "POST",
        payload: {
          epoch: "00000000-0000-4000-8000-000000000001",
          snapshots,
          sourceId: "00000000-0000-4000-8000-000000000002",
        },
        url: "/v1/desktop/usage",
      });
      expect(response.statusCode).toBe(400);
    }
    expect(usage.ingest).not.toHaveBeenCalled();
  });

  it("keeps a comma-bearing model label as one exact filter", async () => {
    const { app, usage } = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/v1/usage?from=2026-08-01&to=2026-08-11&model=vendor%2Cmodel",
    });
    expect(response.statusCode).toBe(200);
    expect(usage.ownAnalytics).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ models: ["vendor,model"] }),
    );
  });

  it("fails closed on cross-origin settings mutations", async () => {
    const { app, usage } = createApp();
    apps.push(app);
    const response = await app.inject({
      headers: { origin: "https://attacker.example" },
      method: "PATCH",
      payload: {
        collectionEnabled: false,
        expectedRevision: 1,
        memberVisibilityDefault: false,
        retentionDays: null,
      },
      url: "/v1/admin/usage/settings",
    });
    expect(response.statusCode).toBe(403);
    expect(usage.updateSettings).not.toHaveBeenCalled();
  });

  it("requires a revision for destructive deletion", async () => {
    const { app, usage } = createApp();
    apps.push(app);
    const response = await app.inject({
      headers: { origin: "https://lori.acme.com" },
      method: "DELETE",
      payload: {},
      url: "/v1/admin/usage",
    });
    expect(response.statusCode).toBe(400);
    expect(usage.deleteUsage).not.toHaveBeenCalled();
  });
});
