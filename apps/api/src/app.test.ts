import { afterEach, describe, expect, it, vi } from "vitest";
import { API_LOG_REDACTION_PATHS, buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import type { DatabaseHealth } from "./db/database.js";
import { IdentityError } from "./auth/identity-service.js";

const config: AppConfig = {
  auth: {
    secret: "test-auth-secret-that-is-at-least-32-characters",
    secureCookies: false,
    setupToken: "test-setup-token-that-is-at-least-32-characters",
  },
  database: {
    host: "127.0.0.1",
    name: "lori_enterprise_test",
    password: "test",
    port: 5432,
    ssl: false,
    user: "lori",
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

const apps: ReturnType<typeof buildApp>[] = [];

function createApp(ready: boolean) {
  const database: DatabaseHealth = {
    check: vi.fn(async () => ready),
    close: vi.fn(async () => undefined),
  };
  const app = buildApp({ config, database });
  apps.push(app);
  return { app, database };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("request logging", () => {
  it("redacts credential-bearing request URLs and authentication headers", () => {
    expect(API_LOG_REDACTION_PATHS).toEqual(
      expect.arrayContaining([
        "req.url",
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.x-api-key",
      ]),
    );
  });
});

describe("health routes", () => {
  it("reports liveness independently of storage", async () => {
    const { app } = createApp(false);
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });

  it("fails readiness when PostgreSQL is unavailable", async () => {
    const { app } = createApp(false);
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "not_ready" });
  });
});

describe("system status", () => {
  it("exposes real foundation state without claiming deferred capabilities", async () => {
    const { app } = createApp(true);
    const response = await app.inject({
      method: "GET",
      url: "/v1/system/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      capabilities: {
        auditLog: false,
        curatedMarketplace: false,
        enrollment: false,
        gateway: false,
        sso: false,
        usageAnalytics: false,
      },
      deployment: {
        api: "operational",
        authentication: "not_configured",
        database: "operational",
        tls: "operational",
      },
      publicUrl: "https://lori.acme.com",
      version: "test",
    });
  });
});

describe("hosted Dashboard separation", () => {
  it("does not expose deployment registration or hosted-link endpoints", async () => {
    const { app } = createApp(true);

    for (const request of [
      { method: "GET", url: "/.well-known/lori-enterprise" },
      { method: "GET", url: "/.well-known/lori-enterprise/challenge" },
      { method: "GET", url: "/v1/admin/enterprise-link" },
      { method: "POST", url: "/v1/admin/enterprise-link/pair" },
      { method: "DELETE", url: "/v1/admin/enterprise-link" },
      { method: "DELETE", url: "/v1/admin/enterprise-link/local" },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
    }
  });
});

describe("error responses", () => {
  it("returns retry timing in both the body and Retry-After header", async () => {
    const { app } = createApp(true);
    app.get("/rate-limited", async () => {
      throw new IdentityError(
        429,
        "rate_limited",
        "Too many requests. Wait before trying again.",
        42,
      );
    });

    const response = await app.inject({ method: "GET", url: "/rate-limited" });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("42");
    expect(response.json()).toMatchObject({
      error: "rate_limited",
      retryAfterSeconds: 42,
    });
  });

  it("keeps malformed JSON requests as safe 400 responses", async () => {
    const { app } = createApp(true);
    const handler = vi.fn(async () => ({ ok: true }));
    app.delete("/bodyless-delete", handler);

    const response = await app.inject({
      headers: { "content-type": "application/json" },
      method: "DELETE",
      payload: "",
      url: "/bodyless-delete",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_request",
      message: "The request body is invalid.",
      requestId: expect.any(String),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("classifies schema failures and returns a support reference", async () => {
    const { app } = createApp(true);
    app.get("/schema-error", async () => {
      const error = Object.assign(new Error("column is missing"), {
        code: "42703",
      });
      throw error;
    });

    const response = await app.inject({ method: "GET", url: "/schema-error" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: "database_schema_unavailable",
      message: expect.stringContaining("migrations"),
      requestId: expect.any(String),
    });
  });

  it("does not expose unknown internal error details", async () => {
    const { app } = createApp(true);
    app.get("/unknown-error", async () => {
      throw new Error("secret database detail");
    });

    const response = await app.inject({ method: "GET", url: "/unknown-error" });
    const body = response.json();

    expect(response.statusCode).toBe(500);
    expect(body).toMatchObject({
      error: "internal_error",
      requestId: expect.any(String),
    });
    expect(body.message).not.toContain("secret database detail");
    expect(body.message).toBe("The server could not complete the request.");
  });
});
