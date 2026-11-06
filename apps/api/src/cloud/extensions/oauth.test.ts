import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CloudActor, CloudWorkService } from "../service.js";
import { CloudExtensions, type Catalog, type Connection } from "./service.js";
import type { Http } from "./transport.js";

// Public discovery metadata observed 2026-10-13. No credentials or user data.
const fixtures = JSON.parse(
  readFileSync(
    new URL("./oauth-providers.fixture.json", import.meta.url),
    "utf8",
  ),
) as {
  id: string;
  resourceUrl: string;
  resource: Record<string, unknown>;
  metadataUrl: string;
  metadata: Record<string, unknown>;
}[];
const catalog = JSON.parse(
  readFileSync(
    new URL("../../../catalog/work-runtime.json", import.meta.url),
    "utf8",
  ),
) as Catalog;
const actor: CloudActor = {
  organizationId: "org",
  memberId: "member",
  userId: "user",
  role: "member",
  browserSessionId: "browser",
};

function setup(
  id: string,
  options: {
    oidc?: boolean;
    challengedScope?: string;
    badIssuer?: boolean;
    wrongMethod?: boolean;
  } = {},
) {
  const fixture = fixtures.find((x) => x.id === id)!;
  const plugin = catalog.plugins.find((x) => x.id === id)!;
  const registrations: Record<string, unknown>[] = [];
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
    rows: [],
  }));
  const http: Http = vi.fn(async (_plugin, url, init) => {
    const result = (json: unknown, status = 200) => ({
      status,
      headers: {},
      body: JSON.stringify(json),
    });
    if (url === plugin.endpoint)
      return {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${fixture.resourceUrl}"${options.challengedScope ? `, scope="${options.challengedScope}"` : ""}`,
        },
        body: "",
      };
    if (url === fixture.resourceUrl) return result(fixture.resource);
    if (url === fixture.metadataUrl && options.oidc) return result({}, 404);
    if (
      url === fixture.metadataUrl ||
      url.includes("/.well-known/openid-configuration")
    )
      return result({
        ...fixture.metadata,
        ...(options.badIssuer ? { issuer: "https://untrusted.test" } : {}),
      });
    if (url === fixture.metadata.registration_endpoint) {
      const request = JSON.parse(init.body!);
      registrations.push(request);
      return result({
        client_id: "synthetic-client",
        token_endpoint_auth_method: options.wrongMethod
          ? "private_key_jwt"
          : request.token_endpoint_auth_method,
        ...(request.token_endpoint_auth_method === "none"
          ? {}
          : { client_secret: "synthetic-client-secret" }),
      });
    }
    return result({}, 404);
  });
  const cloud = {
    config: {
      publicUrl: "http://localhost:8180",
      environment: "development",
      gateway: { secret: "synthetic-encryption-secret-at-least-32" },
    },
    pool: { query },
    transaction: async (fn: (client: unknown) => unknown) => fn({ query }),
  } as unknown as CloudWorkService;
  const e = new CloudExtensions(cloud, { catalog, http });
  const row = {
    id: "connection",
    revision: 1,
    status: "connecting",
  } as Connection;
  const prepare = vi
    .spyOn(e, "prepare")
    .mockResolvedValue({ ...row, authorityHash: "synthetic-authority" });
  vi.spyOn(e, "authorize").mockResolvedValue({ revision: 1 } as never);
  vi.spyOn(e, "connection").mockResolvedValue(row);
  return { e, plugin, fixture, registrations, query, prepare, http };
}

describe("Cloud OAuth provider interoperability", () => {
  it.each(fixtures.map((x) => x.id))(
    "starts a session-bound PKCE connection for %s using its advertised methods",
    async (id) => {
      const { e, plugin, fixture, registrations, query } = setup(id);
      const start = await e.oauth.begin(
        actor,
        id,
        plugin.auth === "registeredOAuth"
          ? { clientId: "synthetic-app", clientSecret: "synthetic-secret" }
          : {},
      );
      const url = new URL(start.authorizationUrl);
      expect(url.origin + url.pathname).toBe(
        fixture.metadata.authorization_endpoint,
      );
      expect(url.searchParams.get("redirect_uri")).toBe(
        "http://localhost:8180/api/v1/work/cloud/extensions/oauth/callback",
      );
      expect(url.searchParams.get("resource")).toBe(fixture.resource.resource);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toMatch(
        /^[A-Za-z0-9_-]{43}$/,
      );
      expect(url.searchParams.get("client_secret")).toBeNull();
      expect(
        query.mock.calls.some(([sql]) =>
          String(sql).includes("INSERT INTO cloud_work_plugin_authorizations"),
        ),
      ).toBe(true);
      if (id === "miro")
        expect(registrations[0]?.token_endpoint_auth_method).toBe(
          "client_secret_post",
        );
      if (plugin.auth === "registeredOAuth")
        expect(registrations).toHaveLength(0);
      if (id === "asana") expect(url.searchParams.has("scope")).toBe(false);
    },
  );
  it("prefers the server's challenged scope and supports OIDC metadata fallback", async () => {
    const { e } = setup("notion", {
      oidc: true,
      challengedScope: "read:workspace",
    });
    const start = await e.oauth.begin(actor, "notion");
    expect(new URL(start.authorizationUrl).searchParams.get("scope")).toBe(
      "read:workspace",
    );
  });
  it("refuses mismatched issuers and unsupported registration methods", async () => {
    await expect(
      setup("notion", { badIssuer: true }).e.oauth.begin(actor, "notion"),
    ).rejects.toMatchObject({ code: "cloud_extension_issuer_binding" });
    await expect(
      setup("miro", { wrongMethod: true }).e.oauth.begin(actor, "miro"),
    ).rejects.toThrow();
  });
  it("rejects missing registered app credentials without replacing an existing connection", async () => {
    const { e, prepare, http } = setup("asana");
    await expect(
      e.oauth.begin(actor, "asana", { clientId: "id" }),
    ).rejects.toMatchObject({
      code: "cloud_extension_app_configuration_required",
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
  });
});
