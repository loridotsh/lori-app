import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { EnterpriseWorkPolicy } from "@lori-enterprise/contracts";
import type { CloudActor, CloudWorkService } from "../service.js";
import { CloudExtensions, type Catalog } from "./service.js";
import { WorkResourceScope } from "../../auth/work-resources.js";
import { defaultWorkPolicy, emptyWorkOverrides } from "../../auth/work-service.js";
import { CredentialVault, hash, publicAddress, redact } from "./security.js";
import {
  approvedUrl,
  McpSession,
  parseSse,
  type Http,
  type Plugin,
} from "./transport.js";
const plugin: Plugin = {
  id: "github",
  name: "GitHub",
  endpoint: "https://api.githubcopilot.com/mcp",
  auth: "token",
  authHosts: [],
  reviewedReads: ["get_me"],
  docsUrl: "https://github.com",
  setup: "Enter token",
};
const notion: Plugin = {
  ...plugin,
  id: "notion",
  name: "Notion",
  endpoint: "https://mcp.notion.com/mcp",
  auth: "oauth",
  authHosts: ["auth.notion.com"],
  reviewedReads: ["get_me"],
};
const catalog: Catalog = {
  plugins: [plugin, notion],
  skills: [
    {
      id: "research",
      name: "Research",
      description: "Research",
      version: "1.0",
      capability: "web",
      instructions: "Bundled instructions",
      references: { "references/creation.md": "Reference content" },
    },
  ],
};
describe("Cloud extension security and stream transport", () => {
  it("exports the exact plugin schema accepted by the worker while keeping the outer envelope closed", () => {
    const e = new CloudExtensions(
      {
        config: { gateway: { secret: "synthetic-schema-fixture-secret" } },
      } as CloudWorkService,
      { catalog },
    );
    const definition = e
      .definitions()
      .find((t) => t.name === "call_plugin_tool")!;
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../../worker/tests/fixtures/cloud-plugin-tool.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(definition).toEqual(fixture);
    expect(definition.parameters.additionalProperties).toBe(false);
    expect(
      (
        definition.parameters.properties as Record<
          string,
          Record<string, unknown>
        >
      ).arguments!.additionalProperties,
    ).toBe(true);
  });
  it("hashes JSON objects canonically across JSONB key reordering", () => {
    expect(
      hash({
        properties: { z: { type: "string" }, a: { type: "number" } },
        type: "object",
      }),
    ).toBe(
      hash({
        type: "object",
        properties: { a: { type: "number" }, z: { type: "string" } },
      }),
    );
  });
  it("binds encrypted credentials to tenant, member, plugin and connection", () => {
    const v = new CredentialVault("test-secret-long-enough-for-fixture");
    const s = v.seal(
      { token: "private-token" },
      "org/member/github/connection",
    );
    expect(s).not.toContain("private-token");
    expect(v.open(s, "org/member/github/connection")).toEqual({
      token: "private-token",
    });
    expect(() => v.open(s, "other/member/github/connection")).toThrow();
  });
  it("rejects catalog escapes, cleartext, credentials, redirects destinations and ports", () => {
    for (const url of [
      "http://api.githubcopilot.com/mcp",
      "https://evil.test/mcp",
      "https://api.githubcopilot.com:444/mcp",
      "https://secret@api.githubcopilot.com/mcp",
      "https://api.githubcopilot.com/mcp#token",
    ])
      expect(() => approvedUrl(plugin, url)).toThrow();
    expect(approvedUrl(plugin, plugin.endpoint).hostname).toBe(
      "api.githubcopilot.com",
    );
  });
  it("blocks private, metadata, mapped, multicast, link-local and reserved network addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "169.254.169.254",
      "168.63.129.16",
      "10.0.0.1",
      "100.100.100.200",
      "172.16.1.2",
      "192.168.1.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fd00::1",
      "fe80::1",
      "2001:db8::1",
    ])
      expect(publicAddress(ip), ip).toBe(false);
    expect(publicAddress("1.1.1.1")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("parses multiline SSE and ignores unrelated notifications", () => {
    expect(
      parseSse(
        'data: {"method":"notice"}\n\ndata: {"jsonrpc":"2.0",\ndata: "id":"id","result":{"text":"ok"}}\n\n',
        "id",
      ),
    ).toMatchObject({ id: "id", result: { text: "ok" } });
    expect(parseSse('data: {"id":"id"}', "id")).toBeUndefined();
  });
  it("redacts escaped, encoded and nested token echoes including object keys", () => {
    const secret = 'a"private\\token';
    const v = redact({ [secret]: [secret, encodeURIComponent(secret)] }, [
      secret,
    ]);
    expect(JSON.stringify(v)).not.toContain("private");
  });
  it("negotiates protocol, carries sessions and never retries a remote failure", async () => {
    const requests: Parameters<Http>[2][] = [];
    const http: Http = async (_p, _u, i) => {
      requests.push(i);
      const body = i.body ? JSON.parse(i.body) : {};
      if (i.method === "DELETE") return { status: 204, headers: {}, body: "" };
      if (body.method === "notifications/initialized")
        return { status: 202, headers: {}, body: "" };
      return {
        status: 200,
        headers: { "mcp-session-id": "safe-session" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "initialize"
              ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
              : { tools: [] },
        }),
      };
    };
    const m = new McpSession(plugin, "token", true, http);
    await m.initialize();
    await m.list("tools");
    expect(requests[2]!.headers!["mcp-session-id"]).toBe("safe-session");
    expect(requests[2]!.headers!["mcp-protocol-version"]).toBe("2025-06-18");
    await m.close();
    expect(requests).toHaveLength(4);
  });
});
const integration =
  process.env.LORI_CLOUD_INTEGRATION_TEST === "1" ? describe : describe.skip;
integration(
  "Cloud extension PostgreSQL lifecycle with synthetic providers",
  () => {
    let admin: Pool, pool: Pool, e: CloudExtensions;
    const schema = `extensions_${randomUUID().replaceAll("-", "")}`;
    const actor: CloudActor = {
      organizationId: "org",
      memberId: "member",
      userId: "user",
      role: "member",
      browserSessionId: "session",
    };
    let policy: EnterpriseWorkPolicy;
    let active = true;
    let tools: unknown[];
    let sent: Record<string, unknown>[];
    let tokenExchanges = 0;
    let refreshExchanges = 0;
    let refreshFailure: "temporary" | "revoked" | undefined;
    let onCall: (() => Promise<void>) | undefined;
    const token = "synthetic-private-token";
    const http: Http = async (p, url, i) => {
      if (i.method === "DELETE") return { status: 204, headers: {}, body: "" };
      if (url.includes("/.well-known/oauth-protected-resource/mcp"))
        return { status: 404, headers: {}, body: "" };
      if (url.includes("/.well-known/oauth-protected-resource"))
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            resource: "https://mcp.notion.com",
            authorization_servers: ["https://auth.notion.com"],
            scopes_supported: ["read"],
          }),
        };
      if (url.includes("/.well-known/oauth-authorization-server"))
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            issuer: "https://auth.notion.com",
            authorization_endpoint: "https://auth.notion.com/authorize",
            token_endpoint: "https://auth.notion.com/token",
            registration_endpoint: "https://auth.notion.com/register",
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          }),
        };
      if (url.endsWith("/register")) {
        expect(JSON.parse(i.body!).redirect_uris).toEqual([
          "https://cloud.fixture.test/api/v1/work/cloud/extensions/oauth/callback",
        ]);
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ client_id: "registered-client" }),
        };
      }
      if (url.endsWith("/token")) {
        const params = new URLSearchParams(i.body);
        if (params.get("grant_type") === "refresh_token") {
          refreshExchanges++;
          if (refreshFailure)
            return {
              status: refreshFailure === "temporary" ? 503 : 400,
              headers: {},
              body: JSON.stringify({
                error:
                  refreshFailure === "temporary"
                    ? "temporarily_unavailable"
                    : "invalid_grant",
              }),
            };
        } else {
          tokenExchanges++;
          expect(params.get("redirect_uri")).toBe(
            "https://cloud.fixture.test/api/v1/work/cloud/extensions/oauth/callback",
          );
        }
        expect(params.get("resource")).toBe("https://mcp.notion.com");
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            access_token: token,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "synthetic-refresh-token",
          }),
        };
      }
      if (!i.body) return { status: 401, headers: {}, body: "" };
      const b = JSON.parse(i.body);
      sent.push(b);
      let result: unknown = {};
      if (b.method === "initialize")
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {}, resources: {} },
        };
      else if (b.method === "notifications/initialized")
        return { status: 202, headers: {}, body: "" };
      else if (b.method === "tools/list") result = { tools };
      else if (b.method === "resources/list")
        result = { resources: [{ uri: "fixture://report", name: "Report" }] };
      else if (b.method === "tools/call") {
        await onCall?.();
        result = {
          content: [{ type: "text", text: `Result ${token}` }],
          untrusted: false,
        };
      } else if (b.method === "resources/read")
        result = {
          contents: [{ uri: "fixture://report", text: "Report data" }],
        };
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ jsonrpc: "2.0", id: b.id, result }),
      };
    };
    beforeAll(async () => {
      const db = {
        host: process.env.DATABASE_HOST ?? "127.0.0.1",
        port: Number(process.env.DATABASE_PORT ?? 55439),
        database: process.env.DATABASE_NAME ?? "lori_cloud_qualification",
        user: process.env.DATABASE_USER ?? "lori_cloud_test",
        password:
          process.env.DATABASE_PASSWORD ??
          "development-cloud-qualification-password",
      };
      admin = new Pool(db);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool({ ...db, options: `-c search_path=${schema},public` });
      await pool.query(
        "CREATE TABLE member(id TEXT,\"organizationId\" TEXT,PRIMARY KEY(id,\"organizationId\"));INSERT INTO member VALUES ('member','org'),('other','org'),('member','other-org');",
      );
      await pool.query(
        readFileSync(
          new URL(
            "../../../migrations/026_cloud_extensions.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      await pool.query("ALTER TABLE cloud_work_plugin_connections ADD COLUMN project_id UUID; ALTER TABLE cloud_work_plugin_authorizations ADD COLUMN project_id UUID");
      const transaction = async <T>(fn: (c: PoolClient) => Promise<T>) => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const r = await fn(c);
          await c.query("COMMIT");
          return r;
        } catch (err) {
          await c.query("ROLLBACK");
          throw err;
        } finally {
          c.release();
        }
      };
      const cloud = {
        pool,
        transaction,
        config: {
          publicUrl: "https://cloud.fixture.test",
          gateway: { secret: "synthetic-encryption-secret-at-least-32" },
        },
        ensure: async () => {
          if (!active) throw Error("Revoked");
        },
        workPolicy: async () => policy,
        // Private Work scope: the member's own policy decides, exactly as in production.
        work: {
          resourceScope: async () =>
            new WorkResourceScope({
              administrator: false,
              approved: { enabled: false, personalInstallations: { plugins: false, providers: false, skills: false }, managedCatalog: [], providerModels: [] },
              memberOverrides: emptyWorkOverrides(),
              organization: defaultWorkPolicy(),
              policy,
            }),
        },
      } as unknown as CloudWorkService;
      e = new CloudExtensions(cloud, { catalog, http });
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });
    beforeEach(async () => {
      active = true;
      policy = {
        schemaVersion: 1,
        enabled: true,
        revision: 1,
        personalInstallations: { plugins: true, skills: true, providers: true },
        managedCatalog: [],
        providerModels: [],
        forceAskMe: false,
        memoryAllowed: true,
      };
      tools = [
        {
          name: "get_me",
          description: "Read account",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string", pattern: "^[a-z]+$" } },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
        },
        {
          name: "write_issue",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ];
      sent = [];
      onCall = undefined;
      tokenExchanges = 0;
      refreshExchanges = 0;
      refreshFailure = undefined;
      await pool.query(
        "TRUNCATE cloud_work_plugin_connections CASCADE;TRUNCATE cloud_work_extension_preferences",
      );
    });
    const search = () =>
      e.execute(actor, {
        id: "search",
        name: "search_plugin_tools",
        arguments: { query: "" },
      }) as Promise<{
        tools: {
          schemaHash: string;
          name: string;
          connectionId: string;
          connectionRevision: number;
          pluginId: string;
        }[];
      }>;
    it("connects only after real initialize/discovery and seals member-private credentials", async () => {
      const connected = await e.connectToken(actor, "github", token);
      expect(connected.status).toBe("connected");
      expect(connected.toolCount).toBe(2);
      const stored = (
        await pool.query("SELECT credential FROM cloud_work_plugin_connections")
      ).rows[0].credential;
      expect(stored).not.toContain(token);
      expect(
        (await e.snapshot({ ...actor, memberId: "other" })).plugins[0]!
          .connection,
      ).toBeNull();
      expect(JSON.stringify(await e.snapshot(actor))).not.toContain(token);
      expect((await search()).tools[0]!.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    });
    it("trusted reviewed read allowlist controls approval; remote annotations cannot grant writes", async () => {
      await e.connectToken(actor, "github", token);
      const found = await search();
      const call = (t: (typeof found.tools)[0]) => ({
        id: "x",
        name: "call_plugin_tool",
        arguments: {
          pluginId: t.pluginId,
          connectionId: t.connectionId,
          connectionRevision: t.connectionRevision,
          name: t.name,
          schemaHash: t.schemaHash,
          arguments: {},
        },
      });
      expect((await e.inspect(actor, call(found.tools[0]!))).mutating).toBe(
        false,
      );
      expect((await e.inspect(actor, call(found.tools[1]!))).mutating).toBe(
        true,
      );
    });
    it("requires exact discovered hash/revision and input schema before network dispatch", async () => {
      await e.connectToken(actor, "github", token);
      const t = (await search()).tools[0]!;
      const args = {
        pluginId: t.pluginId,
        connectionId: t.connectionId,
        connectionRevision: t.connectionRevision,
        name: t.name,
        schemaHash: t.schemaHash,
        arguments: { query: "123" },
      };
      const count = sent.length;
      await expect(
        e.execute(actor, {
          id: "x",
          name: "call_plugin_tool",
          arguments: args,
        }),
      ).rejects.toThrow();
      expect(sent).toHaveLength(count);
      await expect(
        e.inspect(actor, {
          id: "x",
          name: "call_plugin_tool",
          arguments: { ...args, arguments: {}, schemaHash: "0".repeat(64) },
        }),
      ).rejects.toThrow();
    });
    it("redacts remote token echoes and enforces untrusted output marker", async () => {
      await e.connectToken(actor, "github", token);
      const t = (await search()).tools[0]!;
      const result = await e.execute(actor, {
        id: "x",
        name: "call_plugin_tool",
        arguments: {
          pluginId: t.pluginId,
          connectionId: t.connectionId,
          connectionRevision: t.connectionRevision,
          name: t.name,
          schemaHash: t.schemaHash,
          arguments: {},
        },
      });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(result).toMatchObject({ untrusted: true });
    });
    it("rejects disabled policy, and cannot read another member's connection", async () => {
      const conn = await e.connectToken(actor, "github", token);
      await expect(
        e.disconnect({ ...actor, memberId: "other" }, "github", conn.revision),
      ).rejects.toThrow();
      policy = {
        ...policy,
        personalInstallations: {
          ...policy.personalInstallations,
          plugins: false,
        },
      };
      expect((await search()).tools).toHaveLength(0);
      await expect(e.connectToken(actor, "github", token)).rejects.toThrow();
    });
    it("disconnect invalidates exact revision and wipes credentials, tool schemas and pending sign-ins", async () => {
      const r = await e.connectToken(actor, "github", token);
      const t = (await search()).tools[0]!;
      await e.disconnect(actor, "github", r.revision);
      expect((await search()).tools).toEqual([]);
      const row = (
        await pool.query("SELECT * FROM cloud_work_plugin_connections")
      ).rows[0];
      expect(row.credential).toBeNull();
      expect(row.tools).toEqual([]);
      await expect(
        e.inspect(actor, {
          id: "x",
          name: "call_plugin_tool",
          arguments: {
            pluginId: t.pluginId,
            connectionId: t.connectionId,
            connectionRevision: t.connectionRevision,
            name: t.name,
            schemaHash: t.schemaHash,
            arguments: {},
          },
        }),
      ).rejects.toThrow();
    });
    it("loads only exact app bundled skill resources and respects member disable", async () => {
      expect(
        await e.execute(actor, {
          id: "x",
          name: "load_skill",
          arguments: { id: "research" },
        }),
      ).toMatchObject({ content: "Bundled instructions" });
      await expect(
        e.execute(actor, {
          id: "x",
          name: "load_skill",
          arguments: { id: "research", reference: "../../secret" },
        }),
      ).rejects.toThrow();
      await e.setSkill(actor, "research", false);
      await expect(
        e.execute(actor, {
          id: "x",
          name: "load_skill",
          arguments: { id: "research" },
        }),
      ).rejects.toThrow();
    });
    it("completes PKCE/resource/issuer/session bound OAuth exactly once using HTTPS server callback", async () => {
      const begin = await e.oauth.begin(actor, "notion");
      const u = new URL(begin.authorizationUrl);
      expect(u.searchParams.get("redirect_uri")).toBe(
        "https://cloud.fixture.test/api/v1/work/cloud/extensions/oauth/callback",
      );
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      expect(u.searchParams.get("resource")).toBe("https://mcp.notion.com");
      const state = u.searchParams.get("state")!;
      await expect(
        e.oauth.callback(
          { ...actor, browserSessionId: "other-session" },
          { state, code: "code" },
        ),
      ).rejects.toThrow();
      expect(tokenExchanges).toBe(0);
      expect(
        (
          await e.oauth.callback(actor, {
            state,
            code: "code",
            iss: "https://auth.notion.com",
          })
        ).status,
      ).toBe("connected");
      await expect(
        e.oauth.callback(actor, { state, code: "code" }),
      ).rejects.toThrow();
      expect(tokenExchanges).toBe(1);
    });
    it("lets cancellation finish while an OAuth callback waits for its connection lock", async () => {
      const begin = await e.oauth.begin(actor, "notion");
      const state = new URL(begin.authorizationUrl).searchParams.get("state")!;
      const cancellation = await pool.connect();
      let callback: Promise<unknown> | undefined;
      try {
        await cancellation.query("BEGIN");
        const { rows: [backend] } = await cancellation.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await cancellation.query("SELECT id FROM cloud_work_plugin_connections WHERE id=$1 FOR UPDATE", [begin.connectionId]);
        callback = e.oauth.callback(actor, { state, code: "code", iss: "https://auth.notion.com" }).catch((error: unknown) => error);
        // Wait until the callback actually blocks, rather than relying on timing.
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
          const blocked = await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [backend!.pid]);
          waiting = !!blocked.rowCount;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await cancellation.query("DELETE FROM cloud_work_plugin_authorizations WHERE connection_id=$1", [begin.connectionId]);
        await cancellation.query("COMMIT");
        expect(await callback).toMatchObject({ code: "cloud_extension_authorization_expired" });
        expect(tokenExchanges).toBe(0);
      } finally {
        await cancellation.query("ROLLBACK");
        cancellation.release();
        await callback;
      }
    });

    it("cancelled and expired OAuth cannot install credentials or exchange codes", async () => {
      let begin = await e.oauth.begin(actor, "notion");
      await e.disconnect(actor, "notion", 1);
      await expect(
        e.oauth.callback(actor, {
          state: new URL(begin.authorizationUrl).searchParams.get("state")!,
          code: "code",
        }),
      ).rejects.toThrow();
      begin = await e.oauth.begin(actor, "notion");
      await pool.query(
        "UPDATE cloud_work_plugin_authorizations SET expires_at=NOW()-INTERVAL '1 second'",
      );
      await expect(
        e.oauth.callback(actor, {
          state: new URL(begin.authorizationUrl).searchParams.get("state")!,
          code: "code",
        }),
      ).rejects.toThrow();
      expect(tokenExchanges).toBe(0);
    });
    it("policy revision changes invalidate pending OAuth despite unchanged grant", async () => {
      const begin = await e.oauth.begin(actor, "notion");
      policy = { ...policy, revision: 2 };
      await expect(
        e.oauth.callback(actor, {
          state: new URL(begin.authorizationUrl).searchParams.get("state")!,
          code: "code",
        }),
      ).rejects.toThrow();
      expect(tokenExchanges).toBe(0);
    });
    it("connection revocation during a remote response never returns that result", async () => {
      const r = await e.connectToken(actor, "github", token);
      const t = (await search()).tools[0]!;
      onCall = async () => {
        await e.disconnect(actor, "github", r.revision);
      };
      await expect(
        e.execute(actor, {
          id: "x",
          name: "call_plugin_tool",
          arguments: {
            pluginId: t.pluginId,
            connectionId: t.connectionId,
            connectionRevision: t.connectionRevision,
            name: t.name,
            schemaHash: t.schemaHash,
            arguments: {},
          },
        }),
      ).rejects.toThrow();
      expect(sent.filter((x) => x.method === "tools/call")).toHaveLength(1);
    });
    it("concurrent rotating-token refresh is single flight and revision safe", async () => {
      const begin = await e.oauth.begin(actor, "notion");
      await e.oauth.callback(actor, {
        state: new URL(begin.authorizationUrl).searchParams.get("state")!,
        code: "code",
      });
      const r = (
        await pool.query("SELECT * FROM cloud_work_plugin_connections")
      ).rows[0];
      const aad = e.aad(actor, "notion", r.id);
      const credential = e.vault.open<Record<string, unknown>>(
        r.credential,
        aad,
      );
      credential.expiresAt = Date.now() - 1000;
      r.credential = e.vault.seal(credential, aad);
      await pool.query(
        "UPDATE cloud_work_plugin_connections SET credential=$2 WHERE id=$1",
        [r.id, r.credential],
      );
      await Promise.all([
        e.credential(actor, notion, r),
        e.credential(actor, notion, r),
        new CloudExtensions(e.cloud, { catalog, http }).credential(
          actor,
          notion,
          r,
        ),
      ]);
      expect(refreshExchanges).toBe(1);
    });
    it("refreshes without reserving a second database connection", async () => {
      const begin = await e.oauth.begin(actor, "notion");
      await e.oauth.callback(actor, {
        state: new URL(begin.authorizationUrl).searchParams.get("state")!,
        code: "code",
      });
      const r = (
        await pool.query("SELECT * FROM cloud_work_plugin_connections")
      ).rows[0];
      const aad = e.aad(actor, "notion", r.id);
      const credential = e.vault.open<Record<string, unknown>>(
        r.credential,
        aad,
      );
      credential.expiresAt = Date.now() - 1000;
      r.credential = e.vault.seal(credential, aad);
      await pool.query(
        "UPDATE cloud_work_plugin_connections SET credential=$2 WHERE id=$1",
        [r.id, r.credential],
      );
      const limited = new Pool({
        ...pool.options,
        // pg deliberately makes password non-enumerable; spreading options
        // alone silently drops it on databases that require authentication.
        password: pool.options.password,
        max: 1,
        connectionTimeoutMillis: 250,
      });
      const cloud = {
        ...e.cloud,
        pool: limited,
        transaction: async <T>(operation: (c: PoolClient) => Promise<T>) => {
          const c = await limited.connect();
          try {
            await c.query("BEGIN");
            const result = await operation(c);
            await c.query("COMMIT");
            return result;
          } catch (error) {
            await c.query("ROLLBACK");
            throw error;
          } finally {
            c.release();
          }
        },
      } as CloudWorkService;
      try {
        const single = new CloudExtensions(cloud, { catalog, http });
        const refreshed = await single.credential(actor, notion, r);
        expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
        expect(refreshExchanges).toBe(1);
        // The session advisory lock is released before returning the client.
        const check = await limited.query(
          "SELECT count(*)::int AS held FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()",
        );
        expect(check.rows[0].held).toBe(0);
      } finally {
        await limited.end();
      }
    });
    it("refreshes discovered capabilities with a new revision and keeps disabled connections out of network calls", async () => {
      const r = await e.connectToken(actor, "github", token);
      tools = [{ name: "new_tool", inputSchema: { type: "object" } }];
      const refreshed = await e.refreshConnection(actor, "github", r.revision);
      expect(refreshed.revision).toBe(r.revision + 1);
      expect(refreshed.toolCount).toBe(1);
      expect((await search()).tools[0]!.name).toBe("new_tool");
      const disabled = await e.setEnabled(
        actor,
        "github",
        refreshed.revision,
        false,
      );
      const before = sent.length;
      await expect(
        e.refreshConnection(actor, "github", disabled.revision),
      ).rejects.toMatchObject({ code: "cloud_extension_disabled" });
      expect(sent).toHaveLength(before);
    });
    it("recovers expired sign-ins and fences late callbacks without affecting another member", async () => {
      const started = await e.oauth.begin(actor, "notion");
      await e.connectToken({ ...actor, memberId: "other" }, "github", token);
      await pool.query(
        "UPDATE cloud_work_plugin_authorizations SET expires_at=NOW()-INTERVAL '1 second'",
      );
      const snapshot = await e.snapshot(actor);
      expect(
        snapshot.plugins.find((p) => p.id === "notion")!.connection!.status,
      ).toBe("disconnected");
      expect(
        (await e.snapshot({ ...actor, memberId: "other" })).plugins[0]!
          .connection!.status,
      ).toBe("connected");
      await expect(
        e.oauth.callback(actor, {
          state: new URL(started.authorizationUrl).searchParams.get("state")!,
          code: "code",
        }),
      ).rejects.toThrow();
      expect(tokenExchanges).toBe(0);
    });
    it.each(["temporary", "revoked"] as const)(
      "handles %s refresh failures without erasing usable credentials unnecessarily",
      async (failure) => {
        const start = await e.oauth.begin(actor, "notion");
        await e.oauth.callback(actor, {
          state: new URL(start.authorizationUrl).searchParams.get("state")!,
          code: "code",
        });
        const r = (
          await pool.query("SELECT * FROM cloud_work_plugin_connections")
        ).rows[0];
        const aad = e.aad(actor, "notion", r.id);
        const credential = e.vault.open<Record<string, unknown>>(
          r.credential,
          aad,
        );
        credential.expiresAt = Date.now() - 1000;
        r.credential = e.vault.seal(credential, aad);
        await pool.query(
          "UPDATE cloud_work_plugin_connections SET credential=$2 WHERE id=$1",
          [r.id, r.credential],
        );
        refreshFailure = failure;
        await expect(e.credential(actor, notion, r)).rejects.toThrow();
        const row = (
          await pool.query(
            "SELECT * FROM cloud_work_plugin_connections WHERE id=$1",
            [r.id],
          )
        ).rows[0];
        expect(row.status).toBe(
          failure === "temporary" ? "connected" : "reauthRequired",
        );
        expect(row.enabled).toBe(failure === "temporary");
        expect(row.credential).toBe(r.credential);
        expect(refreshExchanges).toBe(1);
        if (failure === "temporary") {
          refreshFailure = undefined;
          expect(
            (await e.credential(actor, notion, row)).expiresAt,
          ).toBeGreaterThan(Date.now());
        }
      },
    );
    it.each(["github", "intercom", "exa"])(
      "validates the bundled %s token connection end to end",
      async (id) => {
        const bundled = JSON.parse(
          readFileSync(
            new URL("../../../catalog/work-runtime.json", import.meta.url),
            "utf8",
          ),
        ) as Catalog;
        const runtime = new CloudExtensions(e.cloud, {
          catalog: bundled,
          http,
        });
        const connected = await runtime.connectToken(actor, id, token);
        expect(connected.status).toBe("connected");
        expect(connected.toolCount).toBe(2);
        const snapshot = await runtime.snapshot(actor);
        expect(
          snapshot.plugins.find((p) => p.id === id)!.connection!.status,
        ).toBe("connected");
        expect(JSON.stringify(snapshot)).not.toContain(token);
      },
    );
    it.each([
      "notion",
      "linear",
      "slack",
      "asana",
      "clickup",
      "miro",
      "sentry",
      "exa",
    ])(
      "completes bundled %s OAuth, discovery, and disconnect with its provider metadata",
      async (id) => {
        const bundled = JSON.parse(
          readFileSync(
            new URL("../../../catalog/work-runtime.json", import.meta.url),
            "utf8",
          ),
        ) as Catalog;
        const fixtures = JSON.parse(
          readFileSync(
            new URL("./oauth-providers.fixture.json", import.meta.url),
            "utf8",
          ),
        );
        const fixture = fixtures.find((x: { id: string }) => x.id === id);
        const plugin = bundled.plugins.find((x) => x.id === id)!;
        const providerHttp: Http = async (p, url, init) => {
          const result = (value: unknown) => ({
            status: 200,
            headers: {},
            body: JSON.stringify(value),
          });
          if (url === plugin.endpoint && !init.headers?.authorization)
            return {
              status: 401,
              headers: {
                "www-authenticate": `Bearer resource_metadata="${fixture.resourceUrl}"`,
              },
              body: "",
            };
          if (url === fixture.resourceUrl) return result(fixture.resource);
          if (url === fixture.metadataUrl) return result(fixture.metadata);
          if (url === fixture.metadata.registration_endpoint) {
            const request = JSON.parse(init.body!);
            return result({
              client_id: "provider-client",
              token_endpoint_auth_method: request.token_endpoint_auth_method,
              ...(request.token_endpoint_auth_method === "none"
                ? {}
                : { client_secret: "synthetic-app-secret" }),
            });
          }
          if (url === fixture.metadata.token_endpoint) {
            const params = new URLSearchParams(init.body);
            expect(params.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(params.get("resource")).toBe(fixture.resource.resource);
            expect(params.get("redirect_uri")).toBe(
              "https://cloud.fixture.test/api/v1/work/cloud/extensions/oauth/callback",
            );
            if (["slack", "asana", "miro"].includes(id))
              expect(params.get("client_secret")).toBe("synthetic-app-secret");
            else expect(params.has("client_secret")).toBe(false);
            return result({
              access_token: token,
              token_type: id === "slack" ? "user" : "Bearer",
              expires_in: 3600,
              refresh_token: "synthetic-refresh",
            });
          }
          return http(p, url, init);
        };
        const runtime = new CloudExtensions(e.cloud, {
          catalog: bundled,
          http: providerHttp,
        });
        const begin = await runtime.oauth.begin(
          actor,
          id,
          plugin.auth === "registeredOAuth"
            ? {
                clientId: "provider-client",
                clientSecret: "synthetic-app-secret",
              }
            : {},
        );
        const connected = await runtime.oauth.callback(actor, {
          state: new URL(begin.authorizationUrl).searchParams.get("state")!,
          code: "synthetic-code",
        });
        expect(connected.status).toBe("connected");
        expect(connected.toolCount).toBe(2);
        const discovered = await runtime.execute(actor, {
          id: "search",
          name: "search_plugin_tools",
          arguments: { pluginId: id },
        });
        expect(JSON.stringify(discovered)).not.toContain(token);
        expect(JSON.stringify(discovered)).toContain("get_me");
        const disconnected = await runtime.disconnect(
          actor,
          id,
          connected.revision,
        );
        expect(disconnected.status).toBe("disconnected");
        expect(disconnected.toolCount).toBe(0);
      },
    );
    it("finds complete read-only tools by natural keywords, pages results, and dispatches nonempty arguments", async () => {
      tools = [
        {
          name: "create_issue",
          description: "Create issues in teams for users",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        {
          name: "list_teams",
          description: "List available teams",
          inputSchema: {
            type: "object",
            properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
        },
        {
          name: "get_me",
          description: "Read current user",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ];
      const runtime = new CloudExtensions(e.cloud, {
        catalog: {
          ...catalog,
          plugins: [{ ...plugin, reviewedReads: ["get_me", "list_teams"] }],
        },
        http,
      });
      await runtime.connectToken(actor, "github", token);
      const find = (offset: number) =>
        runtime.execute(actor, {
          id: "search",
          name: "search_plugin_tools",
          arguments: {
            pluginId: "github",
            query: "list teams current user",
            readOnly: true,
            limit: 1,
            offset,
          },
        }) as Promise<{
          tools: {
            name: string;
            pluginId: string;
            connectionId: string;
            connectionRevision: number;
            schemaHash: string;
          }[];
          nextOffset: number | null;
          total: number;
        }>;
      const first = await find(0);
      expect(first.tools.map((t) => t.name)).toEqual(["list_teams"]);
      expect(first.nextOffset).toBe(1);
      expect(first.total).toBe(2);
      expect((await find(1)).tools.map((t) => t.name)).toEqual(["get_me"]);
      expect((await find(1)).nextOffset).toBeNull();
      const chosen = first.tools[0]!;
      const call = {
        id: "read",
        name: "call_plugin_tool",
        arguments: { ...chosen, arguments: { limit: 1 } },
      };
      // Use only the capability identity fields in the call envelope.
      call.arguments = {
        pluginId: chosen.pluginId,
        connectionId: chosen.connectionId,
        connectionRevision: chosen.connectionRevision,
        name: chosen.name,
        schemaHash: chosen.schemaHash,
        arguments: { limit: 1 },
      };
      expect((await runtime.inspect(actor, call)).mutating).toBe(false);
      await runtime.execute(actor, call);
      expect(sent.filter((s) => s.method === "tools/call")).toHaveLength(1);
      const before = sent.length;
      await expect(
        runtime.execute(actor, {
          ...call,
          arguments: { ...call.arguments, arguments: { limit: -1 } },
        }),
      ).rejects.toThrow();
      expect(sent).toHaveLength(before);
    });
  },
);
