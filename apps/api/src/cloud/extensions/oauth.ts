import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { CloudActor } from "../service.js";
import type { CloudExtensions, Connection, Credential } from "./service.js";
import { approvedUrl, type Plugin } from "./transport.js";
import { failure, hash, sessionHash } from "./security.js";
import { IdentityError } from "../../auth/identity-service.js";
import { clearProjectContext } from "../projects/content.js";
import { readContent } from "../projects/records.js";
interface Pending {
  verifier: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  issuer: string;
  resource: string;
  redirectUri: string;
  policyHash: string;
  tokenAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  issuerParamRequired: boolean;
}
const random = () => randomBytes(32).toString("base64url");
export class CloudOAuth {
  constructor(private e: CloudExtensions) {}
  callbackUrl() {
    const u = new URL(this.e.cloud.config.publicUrl);
    // Caddy and Next expose the API below /api and strip that prefix before
    // forwarding to Fastify's internal /v1 routes.
    const localDevelopment =
      ["development", "test"].includes(this.e.cloud.config.environment) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    return u.protocol === "https:" ||
      (u.protocol === "http:" && localDevelopment)
      ? `${u.origin}/api/v1/work/cloud/extensions/oauth/callback`
      : null;
  }
  private resource(p: Plugin) {
    const u = new URL(p.endpoint);
    u.search = "";
    return u.toString();
  }
  async json(
    p: Plugin,
    url: string,
    init: Parameters<CloudExtensions["http"]>[2] = {},
  ) {
    approvedUrl(p, url);
    const r = await this.e.http(p, url, init);
    if (r.status < 200 || r.status >= 300)
      failure("cloud_extension_authorization_failed");
    try {
      const value = JSON.parse(r.body);
      if (!value || typeof value !== "object" || Array.isArray(value))
        failure();
      return value as Record<string, unknown>;
    } catch {
      return failure("cloud_extension_authorization_invalid");
    }
  }
  async begin(
    a: CloudActor,
    id: string,
    client: { clientId?: string; clientSecret?: string } = {},
  ) {
    const p = this.e.plugin(id);
    if (!["oauth", "oauthOrKey", "registeredOAuth"].includes(p.auth))
      failure("cloud_extension_oauth_unsupported", 400);
    const redirectUri = this.callbackUrl();
    if (!redirectUri) failure("cloud_extension_https_callback_required", 409);
    // Reject missing app credentials before invalidating any previous connection.
    if (
      p.auth === "registeredOAuth" &&
      (!client.clientId?.trim() || !client.clientSecret?.trim())
    )
      failure("cloud_extension_app_configuration_required", 409);
    const signal = AbortSignal.timeout(60000);
    const r = await this.e.prepare(a, p);
    let resource = this.resource(p);
    const endpoint = new URL(resource);
    const metadataUrl = `${endpoint.origin}/.well-known/oauth-protected-resource${endpoint.pathname === "/" ? "" : endpoint.pathname}`;
    try {
      const discoveryResponse = await this.e
        .http(p, p.endpoint, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "oauth-discovery",
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "lori-cloud-work", version: "1.0.0" },
            },
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        })
        .catch(() => undefined);
      const authChallenge = discoveryResponse?.headers["www-authenticate"];
      const hinted = authChallenge?.match(
        /resource_metadata\s*=\s*"([^"]+)"/i,
      )?.[1];
      const challengedScope = authChallenge?.match(
        /(?:^|[,\s])scope\s*=\s*"([^"]+)"/i,
      )?.[1];
      const candidates = [
        ...(hinted ? [hinted] : []),
        metadataUrl,
        `${endpoint.origin}/.well-known/oauth-protected-resource`,
      ];
      let resourceMetadata: Record<string, unknown> | undefined;
      for (const candidate of [...new Set(candidates)]) {
        approvedUrl(p, candidate);
        const response = await this.e.http(p, candidate, {
          headers: { accept: "application/json" },
          signal,
        });
        if (response.status === 404) continue;
        if (response.status < 200 || response.status >= 300)
          failure("cloud_extension_authorization_failed");
        try {
          resourceMetadata = JSON.parse(response.body);
        } catch {
          failure("cloud_extension_authorization_invalid");
        }
        break;
      }
      if (
        !resourceMetadata ||
        typeof resourceMetadata.resource !== "string" ||
        !Array.isArray(resourceMetadata.authorization_servers) ||
        resourceMetadata.authorization_servers.length !== 1
      )
        failure("cloud_extension_resource_binding");
      const canonical = approvedUrl(p, resourceMetadata.resource);
      const basePath = canonical.pathname.replace(/\/$/, "");
      if (
        canonical.origin !== endpoint.origin ||
        canonical.search ||
        !(
          endpoint.pathname === basePath ||
          basePath === "" ||
          endpoint.pathname.startsWith(`${basePath}/`)
        )
      )
        failure("cloud_extension_resource_binding");
      // Resource identifiers are opaque OAuth audience strings. Preserve the
      // provider's exact identifier after validating its endpoint relationship.
      resource = resourceMetadata.resource;
      const issuer = String(resourceMetadata.authorization_servers[0]);
      const authority = approvedUrl(p, issuer);
      if (authority.search) failure("cloud_extension_issuer_binding");
      const issuerPath = authority.pathname.replace(/\/$/, "");
      let metadata: Record<string, unknown> | undefined;
      const metadataCandidates = [
        ...new Set([
          `${authority.origin}/.well-known/oauth-authorization-server${issuerPath}`,
          `${authority.origin}/.well-known/openid-configuration${issuerPath}`,
          `${authority.origin}${issuerPath}/.well-known/openid-configuration`,
        ]),
      ];
      for (const url of metadataCandidates) {
        const response = await this.e.http(p, url, {
          headers: { accept: "application/json" },
          signal,
        });
        if ([404, 405].includes(response.status)) continue;
        if (response.status < 200 || response.status >= 300)
          failure("cloud_extension_authorization_failed");
        try {
          metadata = JSON.parse(response.body);
        } catch {
          failure("cloud_extension_authorization_invalid");
        }
        break;
      }
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
        failure("cloud_extension_authorization_invalid");
      if (
        metadata.issuer !== issuer ||
        !Array.isArray(metadata.code_challenge_methods_supported) ||
        !metadata.code_challenge_methods_supported.includes("S256")
      )
        failure("cloud_extension_issuer_binding");
      const authorizationEndpoint = approvedUrl(
        p,
        String(metadata.authorization_endpoint),
      );
      const tokenEndpoint = approvedUrl(
        p,
        String(metadata.token_endpoint),
      ).toString();
      let clientId = client.clientId?.trim();
      let clientSecret = client.clientSecret;
      const methods = Array.isArray(
        metadata.token_endpoint_auth_methods_supported,
      )
        ? metadata.token_endpoint_auth_methods_supported
        : ["client_secret_basic"];
      let tokenAuthMethod: Pending["tokenAuthMethod"] | undefined;
      if (!clientId) {
        if (
          p.auth === "registeredOAuth" ||
          typeof metadata.registration_endpoint !== "string"
        )
          failure("cloud_extension_app_configuration_required", 409);
        // Confidential-only servers (for example Miro) reject registration with `none`.
        const requestedMethod = methods.includes("none")
          ? "none"
          : methods.includes("client_secret_post")
            ? "client_secret_post"
            : methods.includes("client_secret_basic")
              ? "client_secret_basic"
              : undefined;
        if (!requestedMethod)
          failure("cloud_extension_app_configuration_required", 409);
        const registered = await this.json(
          p,
          approvedUrl(p, metadata.registration_endpoint).toString(),
          {
            method: "POST",
            signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              client_name: "Lori Enterprise Cloud Work",
              redirect_uris: [redirectUri],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: requestedMethod,
            }),
          },
        );
        clientId = z.string().min(1).max(4096).parse(registered.client_id);
        clientSecret = z
          .string()
          .min(1)
          .max(8192)
          .optional()
          .parse(registered.client_secret);
        tokenAuthMethod = z
          .enum(["none", "client_secret_post", "client_secret_basic"])
          .parse(registered.token_endpoint_auth_method ?? requestedMethod);
        if (
          !methods.includes(tokenAuthMethod) ||
          (tokenAuthMethod !== "none" && !clientSecret)
        )
          failure("cloud_extension_app_configuration_required", 409);
      } else {
        tokenAuthMethod = clientSecret
          ? methods.includes("client_secret_post")
            ? "client_secret_post"
            : methods.includes("client_secret_basic")
              ? "client_secret_basic"
              : undefined
          : methods.includes("none")
            ? "none"
            : undefined;
      }
      if (!tokenAuthMethod)
        failure("cloud_extension_app_configuration_required", 409);
      const state = random();
      const verifier = random();
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const scope =
        challengedScope && challengedScope.length <= 8000
          ? challengedScope
          : Array.isArray(resourceMetadata.scopes_supported)
            ? resourceMetadata.scopes_supported
                .filter(
                  (s): s is string => typeof s === "string" && s.length <= 200,
                )
                .slice(0, 100)
                .join(" ")
            : undefined;
      const expiresAt = new Date(Date.now() + 5 * 60000);
      await this.e.cloud.transaction(async (c) => {
        const policy = await this.e.authorize(c, a, "plugin", p.id, true);
        const current = await this.e.connection(c, a, p.id, true);
        if (current.revision !== r.revision || current.status !== "connecting")
          failure("cloud_extension_connection_cancelled", 409);
        const pending: Pending = {
          verifier,
          clientId: clientId!,
          clientSecret,
          tokenEndpoint,
          issuer,
          resource,
          redirectUri,
          policyHash: hash(policy),
          tokenAuthMethod,
          issuerParamRequired:
            metadata.authorization_response_iss_parameter_supported === true,
        };
        await c.query(
          "DELETE FROM cloud_work_plugin_authorizations WHERE expires_at<NOW()",
        );
        await c.query(
          "INSERT INTO cloud_work_plugin_authorizations(state_hash,connection_id,revision,session_hash,sealed,expires_at,project_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [
            hash(state),
            r.id,
            r.revision,
            sessionHash(a),
            this.e.vault.seal(pending, this.e.aad(a, p.id, r.id) + ":oauth"),
            expiresAt,
            a.projectId ?? null,
          ],
        );
      });
      authorizationEndpoint.searchParams.set("response_type", "code");
      authorizationEndpoint.searchParams.set("client_id", clientId!);
      authorizationEndpoint.searchParams.set("redirect_uri", redirectUri);
      authorizationEndpoint.searchParams.set("state", state);
      authorizationEndpoint.searchParams.set("code_challenge", challenge);
      authorizationEndpoint.searchParams.set("code_challenge_method", "S256");
      authorizationEndpoint.searchParams.set("resource", resource);
      if (scope && p.id !== "asana")
        authorizationEndpoint.searchParams.set("scope", scope);
      return {
        connectionId: r.id,
        authorizationUrl: authorizationEndpoint.toString(),
        expiresAt: expiresAt.toISOString(),
      };
    } catch (error) {
      await this.e.cloud.pool.query(
        "UPDATE cloud_work_plugin_connections SET status='disconnected',enabled=FALSE WHERE id=$1 AND revision=$2 AND status='connecting'",
        [r.id, r.revision],
      );
      throw error;
    }
  }
  async callback(
    a: CloudActor,
    input: { state: string; code?: string; error?: string; iss?: string },
  ) {
    const pending = await this.e.cloud.transaction(async (c) => {
      await this.e.cloud.ensure(c, a);
      const scope = (await c.query<{ project_id: string | null }>("SELECT project_id FROM cloud_work_plugin_authorizations WHERE state_hash=$1", [hash(input.state)])).rows[0];
      if (scope?.project_id) {
        a = { ...a, projectId: scope.project_id, projectManagement: true };
        await this.e.scope(c, a, true);
      }
      // Reconnect and disconnect take connection -> authorization locks. Use the
      // same order here, then re-read the authorization after acquiring the lock.
      const connection = (
        await readContent(c, "connection", c.query<Connection>(
          "SELECT c.* FROM cloud_work_plugin_connections c JOIN cloud_work_plugin_authorizations a ON a.connection_id=c.id WHERE a.state_hash=$1 AND c.organization_id=$2 AND ((c.project_id IS NULL AND c.member_id=$3 AND $4::uuid IS NULL) OR c.project_id=$4) FOR UPDATE OF c",
          [hash(input.state), a.organizationId, a.memberId, a.projectId ?? null],
        ))
      ).rows[0];
      if (!connection) failure("cloud_extension_authorization_expired", 409);
      const row = (
        await c.query<{
          connection_id: string;
          revision: number;
          session_hash: string;
          sealed: string;
        }>(
          "SELECT a.* FROM cloud_work_plugin_authorizations a JOIN cloud_work_plugin_connections c ON c.id=a.connection_id WHERE a.state_hash=$1 AND c.organization_id=$2 AND ((c.project_id IS NULL AND c.member_id=$3 AND $4::uuid IS NULL) OR c.project_id=$4) AND a.claimed_at IS NULL AND a.expires_at>NOW() FOR UPDATE OF a",
          [hash(input.state), a.organizationId, a.memberId, a.projectId ?? null],
        )
      ).rows[0];
      if (!row || row.session_hash !== sessionHash(a))
        failure("cloud_extension_authorization_expired", 409);
      const p = this.e.plugin(connection.plugin_id);
      const policy = await this.e.authorize(c, a, "plugin", p.id);
      const payload = this.e.vault.open<Pending>(
        row.sealed,
        this.e.aad(a, p.id, connection.id) + ":oauth",
      );
      if (
        connection.revision !== row.revision ||
        connection.status !== "connecting" ||
        payload.policyHash !== hash(policy)
      )
        failure("cloud_extension_authorization_revoked", 409);
      await c.query(
        "UPDATE cloud_work_plugin_authorizations SET claimed_at=NOW() WHERE state_hash=$1",
        [hash(input.state)],
      );
      return { connection, plugin: p, payload };
    });
    const { connection: r, plugin: p, payload: d } = pending;
    try {
      if (input.error || !input.code)
        failure("cloud_extension_authorization_declined", 400);
      if (
        (d.issuerParamRequired && !input.iss) ||
        (input.iss && input.iss !== d.issuer)
      )
        failure("cloud_extension_issuer_binding", 400);
      const token = await this.token(
        p,
        d.tokenEndpoint,
        {
          grant_type: "authorization_code",
          code: input.code,
          code_verifier: d.verifier,
          client_id: d.clientId,
          redirect_uri: d.redirectUri,
          resource: d.resource,
          ...(d.clientSecret ? { client_secret: d.clientSecret } : {}),
        },
        d.tokenAuthMethod,
      );
      const credential: Credential = {
        ...token,
        apiKey: false,
        clientId: d.clientId,
        clientSecret: d.clientSecret,
        tokenEndpoint: d.tokenEndpoint,
        resource: d.resource,
        issuer: d.issuer,
        tokenAuthMethod: d.tokenAuthMethod,
      };
      const discovered = await this.e.discover(a, p, r, credential);
      // Revalidate authorization and policy after the network exchange. Disconnect, disabled Cloud,
      // session revocation and policy edits all prevent a late callback from installing tokens.
      await this.e.cloud.transaction(async (c) => {
        const policy = await this.e.authorize(c, a, "plugin", p.id);
        if (hash(policy) !== d.policyHash)
          failure("cloud_extension_authorization_revoked", 409);
      });
      return await this.e.install(
        a,
        p,
        { ...r, authorityHash: d.policyHash },
        credential,
        discovered,
      );
    } catch (error) {
      await this.e.cloud.pool.query(
        "UPDATE cloud_work_plugin_connections SET status='disconnected',enabled=FALSE WHERE id=$1 AND revision=$2 AND status='connecting'",
        [r.id, r.revision],
      );
      throw error;
    }
  }
  private async token(
    p: Plugin,
    url: string,
    params: Record<string, string>,
    method: "none" | "client_secret_post" | "client_secret_basic" = "none",
  ) {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    if (method === "client_secret_basic") {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(params.client_id!)}:${encodeURIComponent(params.client_secret!)}`).toString("base64")}`;
      params = { ...params };
      delete params.client_secret;
    }
    if (method === "none") {
      params = { ...params };
      delete params.client_secret;
    }
    const response = await this.e.http(p, approvedUrl(p, url).toString(), {
      method: "POST",
      headers,
      body: new URLSearchParams(params).toString(),
    });
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(response.body);
    } catch {
      return failure("cloud_extension_authorization_invalid");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      failure("cloud_extension_authorization_invalid");
    if (
      response.status === 400 ||
      response.status === 401 ||
      value.ok === false
    ) {
      if (
        [
          "invalid_grant",
          "invalid_client",
          "invalid_refresh_token",
          "token_revoked",
          "token_expired",
        ].includes(String(value.error))
      )
        failure("cloud_extension_reauth_required", 409);
    }
    if (
      response.status < 200 ||
      response.status >= 300 ||
      value.error ||
      value.ok === false
    )
      failure("cloud_extension_authorization_failed");
    if (
      p.id === "slack" &&
      value.authed_user &&
      typeof value.authed_user === "object"
    )
      value = value.authed_user as Record<string, unknown>;
    if (
      value.token_type !== "Bearer" &&
      value.token_type !== "bearer" &&
      !(p.id === "slack" && value.token_type === "user")
    )
      failure("cloud_extension_token_type");
    const accessToken = z
      .string()
      .min(1)
      .max(16384)
      .refine((v) => !/[\r\n]/.test(v))
      .parse(value.access_token);
    const refreshToken = z
      .string()
      .min(1)
      .max(16384)
      .optional()
      .parse(value.refresh_token);
    const expiresIn = z
      .number()
      .int()
      .min(1)
      .max(31536000)
      .optional()
      .parse(value.expires_in);
    if (
      typeof value.resource === "string" &&
      value.resource !== params.resource
    )
      failure("cloud_extension_resource_binding");
    if (
      typeof value.audience === "string" &&
      value.audience !== params.resource
    )
      failure("cloud_extension_resource_binding");
    return {
      accessToken,
      refreshToken,
      ...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    };
  }
  async refresh(
    a: CloudActor,
    p: Plugin,
    r: Connection,
    _old: Credential,
  ): Promise<Credential> {
    // Cross-process advisory lock plus row revision compare prevents duplicate rotating-token refreshes.
    const lock = await this.e.cloud.pool.connect();
    // Reuse the advisory-lock connection. Allocating another client here can
    // exhaust the pool when several members refresh expired connections at once.
    const transaction = async <T>(operation: (c: PoolClient) => Promise<T>) => {
      try {
        await lock.query("BEGIN");
        await lock.query("SET LOCAL statement_timeout='10s'");
        await lock.query("SET LOCAL lock_timeout='5s'");
        const result = await operation(lock);
        await lock.query("COMMIT");
        return result;
      } catch (error) {
        await lock.query("ROLLBACK");
        throw error;
      } finally {
        clearProjectContext(lock);
      }
    };
    try {
      // Session locks survive this short transaction; LOCAL timeouts bound lock
      // acquisition without changing settings on the pooled connection.
      await transaction(async (c) => {
        // A competing process may be finishing the bounded 30-second token
        // exchange. Let it finish rather than revoking a healthy connection.
        await c.query("SET LOCAL statement_timeout='65s'");
        await c.query("SET LOCAL lock_timeout='60s'");
        return c.query("SELECT pg_advisory_lock(hashtext($1))", [
          `cloud-plugin-refresh:${r.id}`,
        ]);
      });
      let authorityHash = "";
      const current = await transaction(async (c) => {
        authorityHash = hash(await this.e.authorize(c, a, "plugin", p.id));
        const now = await this.e.connection(c, a, p.id);
        if (now.revision !== r.revision || !now.enabled || !now.credential)
          failure("cloud_extension_revision_changed", 409);
        return this.e.vault.open<Credential>(
          now.credential!,
          this.e.aad(a, p.id, r.id),
        );
      });
      if (current.expiresAt && current.expiresAt > Date.now() + 30000)
        return current;
      if (
        !current.refreshToken ||
        !current.tokenEndpoint ||
        !current.clientId ||
        !current.resource
      )
        failure("cloud_extension_reauth_required", 409);
      const token = await this.token(
        p,
        current.tokenEndpoint,
        {
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          client_id: current.clientId,
          resource: current.resource,
          ...(current.clientSecret
            ? { client_secret: current.clientSecret }
            : {}),
        },
        current.tokenAuthMethod,
      );
      const next: Credential = {
        ...current,
        ...token,
        expiresAt: token.expiresAt,
        refreshToken: token.refreshToken ?? current.refreshToken,
      };
      await transaction(async (c) => {
        if (
          authorityHash !== hash(await this.e.authorize(c, a, "plugin", p.id))
        )
          failure("cloud_extension_policy_changed", 409);
        const now = await this.e.connection(c, a, p.id, true);
        if (
          now.revision !== r.revision ||
          !now.enabled ||
          now.status !== "connected"
        )
          failure("cloud_extension_revision_changed", 409);
        await c.query(
          "UPDATE cloud_work_plugin_connections SET credential=$2,updated_at=NOW() WHERE id=$1",
          [r.id, this.e.vault.seal(next, this.e.aad(a, p.id, r.id))],
        );
      });
      return next;
    } catch (error) {
      // A timeout, rate limit or unavailable provider does not revoke a member's account.
      if (
        error instanceof IdentityError &&
        error.code === "cloud_extension_reauth_required"
      ) {
        await lock.query(
          "UPDATE cloud_work_plugin_connections SET status='reauthRequired',enabled=FALSE,revision=revision+1,updated_at=NOW() WHERE id=$1 AND revision=$2",
          [r.id, r.revision],
        );
      }
      throw error;
    } finally {
      let unlocked = false;
      try {
        await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [
          `cloud-plugin-refresh:${r.id}`,
        ]);
        unlocked = true;
      } finally {
        // Never return a connection with an uncertain session-lock state.
        lock.release(!unlocked);
      }
    }
  }
}
