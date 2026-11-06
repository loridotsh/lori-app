import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { CloudOAuth } from "./oauth.js";
import type { CloudExtensions } from "./service.js";
import { registerExtensionRoutes } from "./routes.js";
import { IdentityError } from "../../auth/identity-service.js";

describe("Cloud extension public callback routing", () => {
  it("renders a safe recovery page for declined authorization without reflecting provider content", async () => {
    const extensions = {
      cloud: { actor: async () => ({}), throttleRead: async () => {} },
      oauth: { callback: async () => { throw new IdentityError(400, "cloud_extension_authorization_declined", "private detail"); } },
    } as unknown as CloudExtensions;
    const app = Fastify();
    registerExtensionRoutes(app, extensions);
    try {
      const response = await app.inject({ url: "/v1/work/cloud/extensions/oauth/callback?state=private-state&error=access_denied&error_description=%3Cscript%3Esecret%3C%2Fscript%3E" });
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain("Connection cancelled");
      expect(response.body).toContain("Return to Plugins");
      expect(response.body).not.toMatch(/private-state|private detail|secret|<script>/);
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    } finally { await app.close(); }
  });
  it("requires the canonical browser origin and a saved revision for connection refresh", async () => {
    const member = { organizationId: "org", memberId: "member" };
    const refreshConnection = vi.fn(async () => ({ status: "connected" }));
    const extensions = { cloud: { config: { publicUrl: "https://enterprise.test" }, actor: async () => member, throttleMutation: async () => {} }, refreshConnection } as unknown as CloudExtensions;
    const app = Fastify();
    registerExtensionRoutes(app, extensions);
    try {
      const request = { method: "POST" as const, url: "/v1/work/cloud/extensions/plugins/notion/refresh", payload: { expectedRevision: 4 } };
      const refused = await app.inject({ ...request, headers: { origin: "https://untrusted.test" } });
      expect(refused.statusCode).toBe(403);
      expect(refreshConnection).not.toHaveBeenCalled();
      const accepted = await app.inject({ ...request, headers: { origin: "https://enterprise.test" } });
      expect(accepted.statusCode).toBe(200);
      expect(refreshConnection).toHaveBeenCalledWith(member, "notion", 4);
    } finally { await app.close(); }
  });
  it("generates the canonical HTTPS public /api prefix and reaches the internal callback after proxy rewriting", async () => {
    const member = {
      organizationId: "org",
      memberId: "member",
      userId: "user",
      role: "member",
      browserSessionId: "session",
    };
    const callback = vi.fn(async () => ({ status: "connected" }));
    const extensions = {
      cloud: {
        config: { publicUrl: "https://enterprise.example.test:8443" },
        actor: async () => member,
        throttleRead: async () => {},
      },
      oauth: { callback },
    } as unknown as CloudExtensions;
    const url = new CloudOAuth(extensions).callbackUrl()!;
    expect(url).toBe(
      "https://enterprise.example.test:8443/api/v1/work/cloud/extensions/oauth/callback",
    );
    const api = Fastify();
    registerExtensionRoutes(api, extensions);
    try {
      // Both Caddy uri strip_prefix /api and the Next /api/:path* rewrite strip /api.
      const publicCallback = new URL(url);
      publicCallback.searchParams.set("state", "synthetic-state");
      publicCallback.searchParams.set("code", "synthetic-code");
      const response = await api.inject({
        url:
          publicCallback.pathname.slice("/api".length) + publicCallback.search,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(callback).toHaveBeenCalledWith(member, {
        state: "synthetic-state",
        code: "synthetic-code",
      });
      expect(response.body).toContain("Plugin connected");
    } finally {
      await api.close();
    }
  });
  it.each([
    "http://localhost:8180",
    "http://127.0.0.1:8180",
    "http://[::1]:8180",
  ])("allows the exact loopback origin in development: %s", (publicUrl) => {
    const extensions = {
      cloud: { config: { publicUrl, environment: "development" } },
    } as unknown as CloudExtensions;
    expect(new CloudOAuth(extensions).callbackUrl()).toBe(
      `${publicUrl}/api/v1/work/cloud/extensions/oauth/callback`,
    );
  });
  it.each([
    ["http://localhost:8180", "production"],
    ["http://example.test", "development"],
    ["http://localhost.evil.test", "development"],
    ["http://192.168.1.5", "development"],
  ])(
    "refuses insecure non-loopback or production callbacks: %s",
    (publicUrl, environment) => {
      const extensions = {
        cloud: { config: { publicUrl, environment } },
      } as unknown as CloudExtensions;
      expect(new CloudOAuth(extensions).callbackUrl()).toBeNull();
    },
  );
});
