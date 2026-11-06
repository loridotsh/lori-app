import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const fixtureDirectory = mkdtempSync(join(tmpdir(), "lori-enterprise-config-"));
const setupTokenCreatedAtFile = join(fixtureDirectory, "setup-token-created-at");
writeFileSync(setupTokenCreatedAtFile, String(Date.now()));

const productionEnvironment = {
  SETUP_TOKEN_CREATED_AT_FILE: setupTokenCreatedAtFile,
};

afterAll(() => rmSync(fixtureDirectory, { force: true, recursive: true }));

describe("loadConfig", () => {
  it("supports disabling built-in web research and validates a dedicated key", () => {
    const base = { NODE_ENV: "test", WORK_CLOUD_WORKER_SECRET: "synthetic-cloud-worker-secret-32-characters" };
    expect(loadConfig(base).cloud?.webResearchEnabled).toBe(true);
    expect(loadConfig({ ...base, WORK_CLOUD_WEB_RESEARCH_ENABLED: "false" }).cloud?.webResearchEnabled).toBe(false);
    expect(loadConfig({ ...base, WORK_CLOUD_RESEARCH_API_KEY: "" }).cloud?.researchApiKey).toBe("");
    expect(() => loadConfig({ ...base, WORK_CLOUD_RESEARCH_API_KEY: "key\nheader" })).toThrow();
  });
  it("uses an isolated PostgreSQL port for local development", () => {
    const config = loadConfig({ NODE_ENV: "development" });

    expect(config.database.host).toBe("127.0.0.1");
    expect(config.database.port).toBe(55432);
  });

  it("reads operator model limits and refuses to start on malformed ones", () => {
    const base = {
      NODE_ENV: "development",
      WORK_CLOUD_WORKER_SECRET: "a-secure-worker-secret-at-least-32-characters",
    } as const;
    expect(loadConfig(base).cloud?.modelLimits).toEqual({});
    expect(
      loadConfig({
        ...base,
        WORK_CLOUD_MODEL_LIMITS:
          '{"openrouter:vendor/model":{"contextTokens":200000,"outputTokens":8192}}',
      }).cloud?.modelLimits,
    ).toEqual({
      "openrouter:vendor/model": { contextTokens: 200000, outputTokens: 8192 },
    });
    expect(() =>
      loadConfig({ ...base, WORK_CLOUD_MODEL_LIMITS: "{not json" }),
    ).toThrow(/WORK_CLOUD_MODEL_LIMITS/);
    expect(() =>
      loadConfig({
        ...base,
        WORK_CLOUD_MODEL_LIMITS:
          '{"p:m":{"contextTokens":10,"outputTokens":5}}',
      }),
    ).toThrow(/WORK_CLOUD_MODEL_LIMITS/);
  });

  it("trusts forwarding headers only from private proxy peers", () => {
    expect(loadConfig({ NODE_ENV: "development" }).trustProxy).toBe(false);
    expect(
      loadConfig({ NODE_ENV: "development", TRUST_PROXY: "true" }).trustProxy,
    ).toBe("loopback,linklocal,uniquelocal");
    expect(
      loadConfig({ NODE_ENV: "development", TRUST_PROXY: "10.0.0.0/8" })
        .trustProxy,
    ).toBe("10.0.0.0/8");
  });

  it("derives an HTTPS public origin from a production hostname", () => {
    const config = loadConfig({
      ...productionEnvironment,
      BETTER_AUTH_SECRET: "a-secure-auth-secret-at-least-32-characters",
      DATABASE_PASSWORD: "a-secure-database-password-at-least-32-characters",
      LORI_ADDRESS: "lori.acme.com",
      NODE_ENV: "production",
      PROVIDER_GATEWAY_SECRET:
        "a-secure-provider-gateway-secret-at-least-32-characters",
      SETUP_TOKEN: "a-secure-setup-token-at-least-32-characters",
    });

    expect(config.publicUrl).toBe("https://lori.acme.com");
    expect(config.database.password).toBe(
      "a-secure-database-password-at-least-32-characters",
    );
    expect(config.auth.setupTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it("requires a database password in production", () => {
    expect(() =>
      loadConfig({
        ...productionEnvironment,
        BETTER_AUTH_SECRET: "a-secure-auth-secret-at-least-32-characters",
        LORI_ADDRESS: "lori.acme.com",
        NODE_ENV: "production",
        SETUP_TOKEN: "a-secure-setup-token-at-least-32-characters",
      }),
    ).toThrow(/DATABASE_PASSWORD/);
  });

  it("rejects plaintext production origins away from localhost", () => {
    expect(() =>
      loadConfig({
        ...productionEnvironment,
        BETTER_AUTH_SECRET: "a-secure-auth-secret-at-least-32-characters",
        DATABASE_PASSWORD:
          "a-secure-database-password-at-least-32-characters",
        LORI_ADDRESS: "http://lori.acme.com",
        NODE_ENV: "production",
        PROVIDER_GATEWAY_SECRET:
          "a-secure-provider-gateway-secret-at-least-32-characters",
        SETUP_TOKEN: "a-secure-setup-token-at-least-32-characters",
      }),
    ).toThrow(/must use HTTPS/);
  });

  it("rejects addresses containing paths", () => {
    expect(() =>
      loadConfig({
        ...productionEnvironment,
        LORI_ADDRESS: "https://lori.acme.com/admin",
        NODE_ENV: "development",
      }),
    ).toThrow(/must be an origin/);
  });

  it("requires a dedicated provider gateway secret in production", () => {
    expect(() =>
      loadConfig({
        ...productionEnvironment,
        BETTER_AUTH_SECRET: "a-secure-auth-secret-at-least-32-characters",
        DATABASE_PASSWORD:
          "a-secure-database-password-at-least-32-characters",
        LORI_ADDRESS: "lori.acme.com",
        NODE_ENV: "production",
        SETUP_TOKEN: "a-secure-setup-token-at-least-32-characters",
      }),
    ).toThrow(/PROVIDER_GATEWAY_SECRET/);
  });
});
