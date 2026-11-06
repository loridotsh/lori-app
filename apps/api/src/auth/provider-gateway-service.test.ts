import { describe, expect, it } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { LoriAuth } from "./auth.js";
import type { EnrollmentService } from "./enrollment-service.js";
import { ProviderGatewayService } from "./provider-gateway-service.js";
import type { AppConfig } from "../config.js";
import type { Pool } from "pg";

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

type GatewayInternals = {
  decryptApiKey(
    value: string,
    organizationId: string,
    providerId: string,
  ): string;
  encryptApiKey(
    value: string,
    organizationId: string,
    providerId: string,
  ): string;
  issueGatewayToken(deviceId: string, gatewayId: string): {
    expiresAt: string;
    gatewayId: string;
    token: string;
  };
  readGatewayToken(value: string): { d: string; e: number; g: string; v: 1 };
};

function service(): GatewayInternals {
  return new ProviderGatewayService(
    {} as Pool,
    {} as LoriAuth,
    config,
    {} as EnrollmentService,
  ) as unknown as GatewayInternals;
}

function legacyV1Credential(value: string): string {
  const key = createHash("sha256")
    .update("lori-enterprise:provider-gateway:encryption\0", "utf8")
    .update(config.gateway.secret, "utf8")
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher
    .getAuthTag()
    .toString("base64url")}.${ciphertext.toString("base64url")}`;
}

describe("organization provider credential isolation", () => {
  it("encrypts a new credential with organization/provider-bound authenticated data", () => {
    const gateway = service();
    const encrypted = gateway.encryptApiKey("sk-company-secret", "org-a", "openai");

    expect(encrypted).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(gateway.decryptApiKey(encrypted, "org-a", "openai")).toBe(
      "sk-company-secret",
    );
    expect(() => gateway.decryptApiKey(encrypted, "org-b", "openai")).toThrow(
      "cannot be decrypted",
    );
    expect(() => gateway.decryptApiKey(encrypted, "org-a", "anthropic")).toThrow(
      "cannot be decrypted",
    );
  });

  it("keeps legacy v1 ciphertext readable for a safe rolling deployment", () => {
    const gateway = service();
    const legacy = legacyV1Credential("sk-company-secret");

    expect(gateway.decryptApiKey(legacy, "org-a", "openai")).toBe(
      "sk-company-secret",
    );
  });

  it("issues a device- and gateway-scoped temporary credential", () => {
    const gateway = service();
    const issued = gateway.issueGatewayToken("device-a", "gateway-a");
    const claims = gateway.readGatewayToken(`Bearer ${issued.token}`);

    expect(issued.gatewayId).toBe("gateway-a");
    expect(Date.parse(issued.expiresAt)).toBeGreaterThan(Date.now());
    expect(claims).toMatchObject({ d: "device-a", g: "gateway-a", v: 1 });
    expect(() => gateway.readGatewayToken("Bearer not-a-token")).toThrow();
  });
});
