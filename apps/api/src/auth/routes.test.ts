import { afterEach, describe, expect, it, vi } from "vitest";
import { getIp } from "@better-auth/core/utils/ip";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";
import { createPool } from "../db/database.js";
import { createAuth, type LoriAuth } from "./auth.js";
import { IdentityService } from "./identity-service.js";

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
  publicUrl: "http://localhost",
  trustProxy: false,
  version: "test",
};

describe("Better Auth Fastify bridge", () => {
  const close: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(close.splice(0).map((callback) => callback()));
  });

  it.each([
    { trustProxy: false as const, expected: "192.0.2.10" },
    { trustProxy: "192.0.2.10", expected: "198.51.100.20" },
  ])("uses Fastify's trusted client IP with trustProxy=$trustProxy", async ({ trustProxy, expected }) => {
    const pool = createPool(config.database);
    const options = createAuth(pool, config).options;
    const seen: Array<string | null> = [];
    const handler = vi.fn(async (request: Request) => {
      seen.push(getIp(request, options));
      return Response.json({ ok: true });
    });
    const app = buildApp({
      auth: { handler } as unknown as LoriAuth,
      config: { ...config, trustProxy },
      database: { check: async () => true, close: async () => undefined },
      identity: {} as IdentityService,
    });
    close.push(async () => { await app.close(); await pool.end(); });
    for (const spoof of ["203.0.113.1", "203.0.113.2"]) {
      const response = await app.inject({
        method: "POST", url: "/api/auth/sign-in/email", payload: {},
        remoteAddress: "192.0.2.10",
        headers: {
          origin: config.publicUrl,
          "x-forwarded-for": `${spoof}, 198.51.100.20`,
          "x-real-ip": spoof,
          "x-lori-client-ip": spoof,
        },
      });
      expect(response.statusCode).toBe(200);
    }
    expect(seen).toEqual([expected, expected]);
  });

  it("serves the Better Auth health endpoint at the preserved public path", async () => {
    const pool = createPool(config.database);
    const auth = createAuth(pool, config);
    const identity = new IdentityService(pool, auth, config);
    const app = buildApp({
      auth,
      config,
      database: {
        check: async () => true,
        close: async () => undefined,
      },
      identity,
    });
    close.push(async () => {
      await app.close();
      await pool.end();
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/ok",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("rejects Better Auth browser mutations without origin evidence", async () => {
    const pool = createPool(config.database);
    const auth = createAuth(pool, config);
    const identity = new IdentityService(pool, auth, config);
    const app = buildApp({
      auth,
      config,
      database: {
        check: async () => true,
        close: async () => undefined,
      },
      identity,
    });
    close.push(async () => {
      await app.close();
      await pool.end();
    });

    const response = await app.inject({
      method: "POST",
      payload: {},
      url: "/api/auth/sign-in/email",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "untrusted_origin" });
  });
});
