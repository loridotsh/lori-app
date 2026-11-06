import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { LoriAuth } from "./auth.js";
import {
  assertAdminContinuity,
  IdentityError,
  IdentityService,
} from "./identity-service.js";

afterEach(() => vi.restoreAllMocks());

describe("administrator continuity", () => {
  it("prevents demoting or removing the final administrator", () => {
    for (const action of ["demoted", "removed"] as const) {
      expect(() => assertAdminContinuity("admin", 1, action)).toThrowError(
        IdentityError,
      );
    }
  });

  it("allows changes when another administrator remains", () => {
    expect(() => assertAdminContinuity("admin", 2, "removed")).not.toThrow();
    expect(() => assertAdminContinuity("member", 1, "removed")).not.toThrow();
  });

  it("never demotes or removes the owner", () => {
    expect(() => assertAdminContinuity("owner", 5, "removed")).toThrowError(
      expect.objectContaining({ code: "owner_protected" }),
    );
  });
});

describe("setupStatus", () => {
  it("returns docker operator guidance while setup is pending in production", async () => {
    const expiresAt = Date.now() + 15 * 60 * 1_000;
    const pool = {
      query: vi.fn(async () => ({
        rows: [{ completed_at: null, organization_id: null, admin_user_id: null }],
      })),
    } as unknown as Pool;
    const identity = new IdentityService(pool, {} as LoriAuth, {
      auth: {
        secret: "test-auth-secret-that-is-at-least-32-characters",
        secureCookies: false,
        setupToken: "test-setup-token-that-is-at-least-32-characters",
        setupTokenExpiresAt: expiresAt,
      },
      database: {
        host: "127.0.0.1",
        name: "unused",
        password: "test-database-password-at-least-32-characters",
        port: 1,
        ssl: false,
        user: "unused",
      },
      environment: "production",
      gateway: {
        secret: "test-provider-gateway-secret-at-least-32-characters",
      },
      host: "127.0.0.1",
      logLevel: "silent",
      port: 4000,
      publicUrl: "https://lori.example.com",
      trustProxy: "loopback,linklocal,uniquelocal",
      version: "test",
    });

    await expect(identity.setupStatus()).resolves.toEqual({
      publicUrl: "https://lori.example.com",
      state: "requires_setup",
      tokenGuidance: {
        expiresAt: new Date(expiresAt).toISOString(),
        source: "docker_compose",
      },
    });
  });

  it("returns the development token for local setup", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [{ completed_at: null, organization_id: null, admin_user_id: null }],
      })),
    } as unknown as Pool;
    const identity = new IdentityService(pool, {} as LoriAuth, {
      auth: {
        secret: "test-auth-secret-that-is-at-least-32-characters",
        secureCookies: false,
        setupToken: "development-setup-token-change-before-production",
      },
      database: {
        host: "127.0.0.1",
        name: "unused",
        password: "test-database-password-at-least-32-characters",
        port: 1,
        ssl: false,
        user: "unused",
      },
      environment: "development",
      gateway: {
        secret: "test-provider-gateway-secret-at-least-32-characters",
      },
      host: "127.0.0.1",
      logLevel: "silent",
      port: 4000,
      publicUrl: "http://localhost:3000",
      trustProxy: false,
      version: "test",
    });

    await expect(identity.setupStatus()).resolves.toEqual({
      publicUrl: "http://localhost:3000",
      state: "requires_setup",
      tokenGuidance: {
        developmentToken: "development-setup-token-change-before-production",
        source: "local_development",
      },
    });
  });

  it("omits token guidance after setup completes", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          {
            completed_at: new Date().toISOString(),
            organization_id: "org_1",
            admin_user_id: "user_1",
          },
        ],
      })),
    } as unknown as Pool;
    const identity = new IdentityService(pool, {} as LoriAuth, {
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
      environment: "production",
      gateway: {
        secret: "test-provider-gateway-secret-at-least-32-characters",
      },
      host: "127.0.0.1",
      logLevel: "silent",
      port: 4000,
      publicUrl: "https://lori.example.com",
      trustProxy: "loopback,linklocal,uniquelocal",
      version: "test",
    });

    await expect(identity.setupStatus()).resolves.toEqual({
      publicUrl: "https://lori.example.com",
      state: "ready",
    });
  });
});

describe("rate limits", () => {
  it("returns an actionable retry delay", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const pool = {
      query: vi.fn(async () => ({
        rows: [{ count: 2, lastRequest: "995000" }],
      })),
    } as unknown as Pool;
    const identity = new IdentityService(
      pool,
      {} as LoriAuth,
      {} as AppConfig,
    );

    await expect(
      identity.enforceRateLimit("test", 1, 60),
    ).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 55,
      statusCode: 429,
    });
  });
});
