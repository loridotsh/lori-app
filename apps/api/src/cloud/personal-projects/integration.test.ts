import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import type { LoriAuth } from "../../auth/auth.js";
import { IdentityService } from "../../auth/identity-service.js";
import { EnrollmentService } from "../../auth/enrollment-service.js";
import { TeamService } from "../../auth/team-service.js";
import { WorkService, defaultWorkPolicy } from "../../auth/work-service.js";
import { ProviderGatewayService } from "../../auth/provider-gateway-service.js";
import { CloudWorkService, type CloudActor } from "../service.js";
import { provisionRuntime } from "../../db/provision-runtime.js";
import { bytesHash } from "../files.js";
import { buildApp } from "../../app.js";
import { notifications } from "../notifications.js";

const integration = process.env.LORI_CLOUD_INTEGRATION_TEST === "1" ? describe : describe.skip;
integration("Personal projects with a non-owner, non-bypass PostgreSQL runtime", () => {
  const suffix = randomUUID().replaceAll("-", ""), schema = `personal_${suffix}`, role = `personal_runtime_${suffix}`;
  let admin: Pool, migration: Pool, pool: Pool, cloud: CloudWorkService, identity: IdentityService, directory: string, gatewayId: string;
  let app: ReturnType<typeof buildApp>;
  const origin = "https://cloud.example.test";
  const headers = { origin };
  const a = (name: string, organizationId = "org"): CloudActor => ({ organizationId, memberId: `${name}-member`, userId: name, role: name === "owner" || name === "outside" ? "admin" : "member", browserSessionId: `session-${name}` });
  const administrator = (): CloudActor => ({ ...a("owner"), headers });
  const personal = () => cloud.personalProjects;
  const projectInput = (name = "Quarterly planning") => ({ requestId: randomUUID(), name, description: "A private folder", instructions: "Answer as a careful analyst." });
  const make = (actor: CloudActor, name?: string) => personal().create(actor, projectInput(name));
  const openChat = (actor: CloudActor, projectId: string, title = "Chat") => personal().createConversation(actor, projectId, { title });
  const send = (actor: CloudActor, conversationId: string, revision: number, text = "Hello") =>
    cloud.submit(actor, conversationId, { requestId: randomUUID(), text, gatewayId, modelId: "test-model", expectedRevision: revision });
  const policy = async (change: Partial<{ allowAll: boolean; grants: { kind: "member" | "team"; subjectId: string }[]; blockedMemberIds: string[]; maxPerMember: number | null }> = {}) => {
    const current = await personal().policy(a("owner"));
    return personal().setPolicy(administrator(), {
      expectedRevision: current.revision,
      allowAll: current.allowAll,
      grants: current.grants,
      blockedMemberIds: current.blockedMemberIds,
      maxPerMember: current.maxPerMember,
      ...change,
    });
  };
  const bytes = (text: string) => Buffer.from(text);
  const upload = (actor: CloudActor, projectId: string, name: string, content: Buffer | string, mimeType = "text/plain") =>
    personal().references.upload(actor, projectId, { name, mimeType, bytes: Buffer.isBuffer(content) ? content : bytes(content), requestId: randomUUID() });
  let session = "owner";

  beforeAll(async () => {
    directory = await mkdtemp(resolve(tmpdir(), "lori-personal-test-"));
    const config = loadConfig({ ...process.env, NODE_ENV: "test", LORI_ADDRESS: origin, WORK_CLOUD_WORKER_SECRET: "test-personal-worker-secret-never-a-real-secret" });
    config.cloud!.filesDirectory = resolve(directory, "files");
    const db = { host: config.database.host, port: config.database.port, database: config.database.name, user: config.database.user, password: config.database.password };
    admin = new Pool(db);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    migration = new Pool({ ...db, options: `-c search_path=${schema},public` });
    for (const file of readdirSync(resolve(import.meta.dirname, "../../../migrations")).filter((f) => /^\d+_.*\.sql$/.test(f)).sort())
      await migration.query(readFileSync(resolve(import.meta.dirname, "../../../migrations", file), "utf8"));
    const runtimePassword = randomBytes(32).toString("base64url");
    await provisionRuntime(migration, role, runtimePassword);
    pool = new Pool({ ...db, user: role, password: runtimePassword, options: `-c search_path=${schema},public`, max: 6 });
    await migration.query(`INSERT INTO organization(id,name,slug,"createdAt") VALUES('org','Organization','org',NOW()),('other','Other','other',NOW());
      INSERT INTO organization_policies(organization_id) VALUES('org'),('other');`);
    for (const name of ["owner", "alice", "bob", "carol", "outside"]) {
      const org = name === "outside" ? "other" : "org";
      await migration.query('INSERT INTO "user"(id,name,email,"createdAt","updatedAt") VALUES($1,$1,$2,NOW(),NOW())', [name, `${name}@test.invalid`]);
      await migration.query('INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,$4,NOW())', [`${name}-member`, org, name, name === "owner" || name === "outside" ? "admin" : "member"]);
      await migration.query('INSERT INTO session(id,token,"userId","createdAt","updatedAt","expiresAt") VALUES($1,$1,$2,NOW(),NOW(),NOW()+INTERVAL \'1 day\')', [`session-${name}`, name]);
    }
    await migration.query("INSERT INTO team(id,organization_id,name,slug) VALUES('team-a','org','Analysts','analysts'),('team-other','other','Foreign','foreign')");
    await migration.query("INSERT INTO team_member(id,team_id,member_id) VALUES('tm-bob','team-a','bob-member')");
    for (const org of ["org", "other"])
      await migration.query("INSERT INTO organization_work_policies(organization_id,policy) VALUES($1,$2)", [org, JSON.stringify({ ...defaultWorkPolicy(), enabled: true, memoryAllowed: true, managedCatalog: [{ type: "provider", id: "openai", enabled: true }], providerModels: [{ providerId: "openai", modelIds: ["test-model"] }] })]);
    const auth = { api: { getSession: async () => ({ session: { id: `session-${session}`, userId: session }, user: { id: session } }) } } as unknown as LoriAuth;
    identity = new IdentityService(pool, auth, config);
    const enrollment = new EnrollmentService(pool, auth, config);
    const teams = new TeamService(pool, auth, config, enrollment);
    const work = new WorkService(pool, identity, teams, enrollment);
    const providers = new ProviderGatewayService(pool, auth, config, enrollment, work);
    cloud = new CloudWorkService(pool, config, identity, enrollment, work, providers);
    await providers.createWorkOrganizationGateway(headers, { providerId: "openai", apiKey: "synthetic-test-provider-secret", requestsPerMinute: 60, expectedRevision: 1 });
    gatewayId = (await migration.query("SELECT id FROM organization_provider_gateways WHERE organization_id='org'")).rows[0].id;
    app = buildApp({ config, database: { check: async () => true, close: async () => {} }, pool, identity, enrollment, work, providerGateway: providers });
  }, 30000);
  afterAll(async () => {
    await app?.close();
    await cloud?.tools.close();
    await cloud?.files.close();
    await pool?.end();
    await migration?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      if ((await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount) {
        await admin.query(`DROP OWNED BY "${role}"`);
        await admin.query(`DROP ROLE "${role}"`);
      }
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  beforeEach(async () => {
    session = "owner";
    await migration.query(`DELETE FROM cloud_work_runs; DELETE FROM cloud_work_conversations; DELETE FROM cloud_work_personal_projects;
      DELETE FROM cloud_work_personal_project_requests; DELETE FROM cloud_work_personal_project_creation_grants; DELETE FROM cloud_work_personal_project_creation_blocks;
      DELETE FROM cloud_work_personal_project_settings; DELETE FROM cloud_work_memory_notes; DELETE FROM cloud_work_projects; UPDATE cloud_work_settings SET retention_days=90`);
  });

  describe("who may create", () => {
    it.each([false, true])("administers personal creation without team readiness (team enabled=%s)", async enabled => {
      const previous = cloud.config.cloud!.projectsEnabled;
      cloud.config.cloud!.projectsEnabled = enabled;
      try {
        // No team keyring is configured in this suite.
        expect((await cloud.projects.capabilities(a("owner"))).available).toBe(false);
        expect(await personal().capabilities(a("owner"))).toMatchObject({ available: true, canAdminister: true });
        expect((await personal().directory(a("owner"))).members).toHaveLength(4);
        await policy({ allowAll: true });
        expect((await personal().capabilities(a("alice"))).canCreate).toBe(true);
        expect((await make(a("alice"))).status).toBe("active");
      } finally {
        cloud.config.cloud!.projectsEnabled = previous;
      }
    });
    it("lets administrators create by default and everyone else only after an administrator enables it", async () => {
      expect(await personal().capabilities(a("owner"))).toMatchObject({ available: true, canCreate: true, source: "organization_admin", canAdminister: true });
      expect(await personal().capabilities(a("alice"))).toMatchObject({ available: true, canCreate: false, source: "none", canAdminister: false });
      await expect(make(a("alice"))).rejects.toMatchObject({ statusCode: 403, code: "personal_project_creation_denied" });
      await policy({ allowAll: true });
      expect(await personal().capabilities(a("alice"))).toMatchObject({ canCreate: true, source: "everyone" });
      expect((await make(a("alice"))).status).toBe("active");
    });
    it("honors member and team grants while the organization switch is off, and reports each source", async () => {
      await policy({ grants: [{ kind: "member", subjectId: "alice-member" }, { kind: "team", subjectId: "team-a" }] });
      expect(await personal().effective(a("owner"), "alice-member")).toEqual({ memberId: "alice-member", allowed: true, source: "member_grant" });
      expect(await personal().effective(a("owner"), "bob-member")).toEqual({ memberId: "bob-member", allowed: true, source: "team_grant" });
      expect(await personal().effective(a("owner"), "carol-member")).toEqual({ memberId: "carol-member", allowed: false, source: "none" });
      expect((await make(a("bob"))).status).toBe("active");
      await expect(make(a("carol"))).rejects.toMatchObject({ code: "personal_project_creation_denied" });
    });
    it("lets an explicit block override every grant, including the organization switch and the administrator default", async () => {
      await policy({ allowAll: true, grants: [{ kind: "member", subjectId: "alice-member" }], blockedMemberIds: ["alice-member", "owner-member"] });
      expect(await personal().effective(a("owner"), "alice-member")).toMatchObject({ allowed: false, source: "blocked" });
      await expect(make(a("alice"))).rejects.toMatchObject({ code: "personal_project_creation_denied" });
      await expect(make(a("owner"))).rejects.toMatchObject({ code: "personal_project_creation_denied" });
      expect((await make(a("bob"))).status).toBe("active");
    });
    it("keeps existing projects usable after the permission is removed", async () => {
      await policy({ allowAll: true });
      const project = await make(a("alice"));
      const chat = await openChat(a("alice"), project.id);
      await policy({ allowAll: false, blockedMemberIds: ["alice-member"] });
      await expect(make(a("alice"))).rejects.toMatchObject({ code: "personal_project_creation_denied" });
      expect((await personal().detail(a("alice"), project.id)).id).toBe(project.id);
      expect((await personal().list(a("alice"), { status: "active", limit: 10 })).projects.map((p) => p.id)).toEqual([project.id]);
      expect((await send(a("alice"), chat.id, chat.revision)).run.status).toBe("queued");
      expect((await personal().update(a("alice"), project.id, { expectedRevision: project.revision, instructions: "Still editable." })).instructions).toBe("Still editable.");
      expect((await openChat(a("alice"), project.id, "Second")).personalProjectId).toBe(project.id);
    });
    it("validates policy subjects, revisions and the caller's administrator role", async () => {
      const current = await personal().policy(a("owner"));
      const next = { expectedRevision: current.revision, allowAll: current.allowAll, grants: current.grants, blockedMemberIds: current.blockedMemberIds, maxPerMember: current.maxPerMember };
      await expect(personal().setPolicy(administrator(), { ...next, expectedRevision: current.revision + 5 })).rejects.toMatchObject({ code: "personal_project_policy_conflict" });
      await expect(personal().setPolicy(administrator(), { ...next, grants: [{ kind: "team", subjectId: "team-other" }] })).rejects.toMatchObject({ code: "personal_project_subject_not_found" });
      await expect(personal().setPolicy(administrator(), { ...next, blockedMemberIds: ["outside-member"] })).rejects.toMatchObject({ code: "personal_project_subject_not_found" });
      await expect(personal().setPolicy(administrator(), { ...next, grants: [{ kind: "member", subjectId: "alice-member" }, { kind: "member", subjectId: "alice-member" }] })).rejects.toMatchObject({ code: "personal_project_duplicate_grant" });
      session = "alice";
      await expect(personal().setPolicy({ ...a("alice"), headers }, next)).rejects.toMatchObject({ statusCode: 403 });
      await expect(personal().policy(a("alice"))).rejects.toMatchObject({ code: "admin_required" });
      await expect(personal().effective(a("alice"), "bob-member")).rejects.toMatchObject({ code: "admin_required" });
      await expect(personal().directory(a("alice"))).rejects.toMatchObject({ code: "admin_required" });
      expect((await personal().directory(a("owner"))).members.length).toBe(4);
    });
    it("is unavailable, not merely denied, when Cloud Work is off for the member", async () => {
      await migration.query("UPDATE organization_work_policies SET policy=jsonb_set(policy,'{enabled}','false') WHERE organization_id='org'");
      try {
        expect(await personal().capabilities(a("owner"))).toMatchObject({ available: false, canCreate: false, source: "unavailable" });
        await expect(make(a("owner"))).rejects.toMatchObject({ statusCode: 403 });
        await expect(personal().list(a("owner"), { status: "active", limit: 5 })).rejects.toMatchObject({ statusCode: 403 });
      } finally {
        await migration.query("UPDATE organization_work_policies SET policy=jsonb_set(policy,'{enabled}','true') WHERE organization_id='org'");
      }
    });
  });

  describe("owner-only privacy", () => {
    it("applies caller RLS to preview metadata and versions owned by a superuser", async () => {
      await policy({ allowAll: true });
      const ownerProject = await make(a("owner"));
      const aliceProject = await make(a("alice"));
      const ownerReference = await upload(a("owner"), ownerProject.id, "owner.txt", "owner secret");
      const aliceReference = await upload(a("alice"), aliceProject.id, "alice.txt", "alice secret");
      for (const [view, column] of [["cloud_work_preview_sources", "id"], ["cloud_work_preview_source_versions", "file_id"]]) {
        expect((await pool.query(`SELECT * FROM ${view}`)).rows).toEqual([]);
        const seen = (who: CloudActor) => cloud.transaction(async c => {
          await cloud.ensure(c, who);
          return (await c.query(`SELECT ${column} AS id FROM ${view}`)).rows.map(row => row.id);
        });
        expect(await seen(a("owner"))).toEqual([ownerReference.id]);
        expect(await seen(a("alice"))).toEqual([aliceReference.id]);
        expect(await seen(a("outside", "other"))).toEqual([]);
        const internal = await cloud.transaction(async c => {
          await c.query("SELECT set_config('lori.personal_scope','internal',true)");
          return (await c.query(`SELECT ${column} AS id FROM ${view}`)).rows.map(row => row.id);
        });
        expect(internal.sort()).toEqual([ownerReference.id, aliceReference.id].sort());
        expect((await pool.query(`SELECT * FROM ${view}`)).rows).toEqual([]);
      }
    });
    it("answers identically for other members, administrators, other organizations and unknown ids", async () => {
      const project = await make(a("owner"), "Confidential merger");
      const chat = await openChat(a("owner"), project.id, "Secret chat");
      const reference = await upload(a("owner"), project.id, "terms.txt", "secret terms");
      const probe = [a("alice"), a("bob"), a("outside", "other")];
      const unknown = randomUUID();
      for (const who of probe) {
        const missing = { statusCode: 404, code: "personal_project_not_found" };
        await expect(personal().detail(who, project.id)).rejects.toMatchObject(missing);
        await expect(personal().update(who, project.id, { expectedRevision: 1, name: "Hijacked" })).rejects.toMatchObject(missing);
        await expect(personal().lifecycle(who, project.id, { requestId: randomUUID(), status: "deleted", expectedRevision: 1 })).rejects.toMatchObject(missing);
        await expect(personal().createConversation(who, project.id, { title: "Mine" })).rejects.toMatchObject(missing);
        await expect(personal().references.list(who, project.id)).rejects.toMatchObject(missing);
        await expect(cloud.list(who, 10, undefined, undefined, project.id)).rejects.toMatchObject(missing);
        await expect(personal().references.download(who, reference.id)).rejects.toMatchObject({ statusCode: 404 });
        await expect(personal().references.remove(who, reference.id, 1, reference.sha256)).rejects.toMatchObject({ statusCode: 404 });
        await expect(cloud.detail(who, chat.id)).rejects.toMatchObject({ statusCode: 404 });
        await expect(personal().moveConversation(who, chat.id, { requestId: randomUUID(), personalProjectId: null, expectedRevision: chat.revision })).rejects.toMatchObject({ statusCode: 404 });
        expect((await personal().list(who, { status: "active", limit: 50 })).projects).toEqual([]);
      }
      await expect(personal().detail(a("owner"), unknown)).rejects.toMatchObject({ statusCode: 404, code: "personal_project_not_found" });
      // An administrator gains no access to another owner's content.
      await policy({ allowAll: true });
      const alicesProject = await make(a("alice"), "Alice only");
      await expect(personal().detail(a("owner"), alicesProject.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(cloud.detail(a("owner"), (await openChat(a("alice"), alicesProject.id)).id)).rejects.toMatchObject({ statusCode: 404 });
    });
    it("closes row-level security without a verified identity and across owners", async () => {
      const project = await make(a("owner"), "RLS case");
      await upload(a("owner"), project.id, "ref.txt", "contents");
      for (const table of ["cloud_work_personal_projects", "cloud_work_personal_project_references", "cloud_work_personal_project_reference_versions"])
        expect((await pool.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
      const seen = async (who: CloudActor) => cloud.transaction(async (c) => {
        await cloud.ensure(c, who);
        return (await c.query("SELECT id FROM cloud_work_personal_projects")).rowCount;
      });
      expect(await seen(a("owner"))).toBe(1);
      expect(await seen(a("alice"))).toBe(0);
      expect(await seen(a("outside", "other"))).toBe(0);
      await expect(cloud.transaction(async (c) => {
        await cloud.ensure(c, a("alice"));
        await c.query("INSERT INTO cloud_work_personal_projects(id,organization_id,member_id,name) VALUES($1,'org','owner-member','Forged')", [randomUUID()]);
      })).rejects.toMatchObject({ code: "42501" });
      // The blob directory is deliberately content free, so storage cleanup can read it without an owner.
      expect((await pool.query("SELECT 1 FROM cloud_work_personal_blob_references")).rowCount).toBe(1);
    });
    it("never records names, instructions or references in audit events", async () => {
      await policy({ allowAll: true });
      const project = await make(a("alice"), "Layoff plan");
      await personal().update(a("alice"), project.id, { expectedRevision: project.revision, instructions: "Never reveal salaries" });
      await upload(a("alice"), project.id, "salaries.csv", "a,b");
      const audit = JSON.stringify((await migration.query("SELECT action,subject_id,metadata FROM audit_events WHERE action LIKE 'work.personal_project.%'")).rows);
      expect(audit).toContain("work.personal_project.created");
      for (const secret of ["Layoff", "salaries", "Never reveal"]) expect(audit).not.toContain(secret);
    });
  });

  describe("lifecycle", () => {
    it("replays creation and refuses a changed body under the same request id", async () => {
      const input = projectInput("Idempotent");
      const first = await personal().create(a("owner"), input);
      expect((await personal().create(a("owner"), input)).id).toBe(first.id);
      expect((await migration.query("SELECT 1 FROM cloud_work_personal_projects")).rowCount).toBe(1);
      await expect(personal().create(a("owner"), { ...input, name: "Different" })).rejects.toMatchObject({ statusCode: 409, code: "personal_project_idempotency_conflict" });
      const conversation = { title: "Once", requestId: randomUUID() };
      const chat = await personal().createConversation(a("owner"), first.id, conversation);
      expect((await personal().createConversation(a("owner"), first.id, conversation)).id).toBe(chat.id);
    });
    it("counts archived and recoverable-deleted projects against the per-member limit", async () => {
      await policy({ maxPerMember: 2 });
      const one = await make(a("owner"));
      const two = await make(a("owner"));
      await expect(make(a("owner"))).rejects.toMatchObject({ statusCode: 409, code: "personal_project_limit" });
      const archived = await personal().lifecycle(a("owner"), one.id, { requestId: randomUUID(), status: "archived", expectedRevision: one.revision });
      await personal().lifecycle(a("owner"), two.id, { requestId: randomUUID(), status: "deleted", expectedRevision: two.revision });
      await expect(make(a("owner"))).rejects.toMatchObject({ code: "personal_project_limit" });
      expect(await personal().capabilities(a("owner"))).toMatchObject({ count: 2, limit: 2, canCreate: false });
      // Another member is unaffected by this member's count.
      await policy({ allowAll: true });
      expect((await make(a("alice"))).status).toBe("active");
      expect(archived.status).toBe("archived");
    });
    it("defaults the retained limit to 100 and lets the server configuration set it", async () => {
      const capabilities = await personal().capabilities(a("owner"));
      expect(capabilities.limit).toBe(100);
      expect((await personal().policy(a("owner"))).defaultMaxPerMember).toBe(100);
    });
    it("uses optimistic revisions and bounds names, descriptions and instructions", async () => {
      const project = await make(a("owner"));
      const renamed = await personal().update(a("owner"), project.id, { expectedRevision: project.revision, name: "Renamed", description: "New" });
      expect(renamed).toMatchObject({ name: "Renamed", description: "New", revision: project.revision + 1, instructions: project.instructions });
      await expect(personal().update(a("owner"), project.id, { expectedRevision: project.revision, name: "Stale" })).rejects.toMatchObject({ statusCode: 409, code: "personal_project_revision_conflict" });
      await expect(migration.query("UPDATE cloud_work_personal_projects SET name=' padded ' WHERE id=$1", [project.id])).rejects.toMatchObject({ code: "23514" });
      await expect(migration.query("UPDATE cloud_work_personal_projects SET instructions=repeat('x',48001) WHERE id=$1", [project.id])).rejects.toMatchObject({ code: "23514" });
    });
    it("lists with bounded cursors, by status, newest first", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await make(a("owner"), `Project ${i}`)).id);
      await personal().lifecycle(a("owner"), ids[0]!, { requestId: randomUUID(), status: "archived", expectedRevision: 1 });
      const first = await personal().list(a("owner"), { status: "active", limit: 2 });
      expect(first.projects).toHaveLength(2);
      expect(first.nextCursor).toBe(first.projects[1]!.id);
      const second = await personal().list(a("owner"), { status: "active", limit: 2, cursor: first.nextCursor! });
      expect([...first.projects, ...second.projects].map((p) => p.id)).toEqual([ids[4], ids[3], ids[2], ids[1]]);
      expect(second.nextCursor).toBeNull();
      expect((await personal().list(a("owner"), { status: "archived", limit: 10 })).projects.map((p) => p.id)).toEqual([ids[0]]);
      await expect(personal().list(a("owner"), { status: "archived", limit: 10, cursor: ids[1]! })).rejects.toMatchObject({ code: "personal_project_cursor_invalid" });
      await expect(personal().list(a("alice"), { status: "active", limit: 10, cursor: ids[1]! })).rejects.toMatchObject({ code: "personal_project_cursor_invalid" });
    });
    it("makes an archived project read-only and a deleted project invisible, and restores both", async () => {
      const project = await make(a("owner"));
      const chat = await openChat(a("owner"), project.id);
      await upload(a("owner"), project.id, "kept.txt", "kept");
      const archived = await personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "archived", expectedRevision: project.revision });
      expect(archived).toMatchObject({ status: "archived", conversationCount: 1, referenceCount: 1 });
      await expect(send(a("owner"), chat.id, chat.revision)).rejects.toMatchObject({ statusCode: 409, code: "personal_project_archived" });
      await expect(openChat(a("owner"), project.id)).rejects.toMatchObject({ code: "personal_project_archived" });
      await expect(upload(a("owner"), project.id, "new.txt", "x")).rejects.toMatchObject({ code: "personal_project_archived" });
      await expect(personal().update(a("owner"), project.id, { expectedRevision: archived.revision, name: "No" })).rejects.toMatchObject({ code: "personal_project_archived" });
      expect((await cloud.detail(a("owner"), chat.id)).conversation.personalProjectId).toBe(project.id);
      expect((await personal().references.list(a("owner"), project.id)).references).toHaveLength(1);
      const restored = await personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "active", expectedRevision: archived.revision });
      expect(restored.archivedAt).toBeNull();
      expect((await send(a("owner"), chat.id, chat.revision)).run.status).toBe("queued");
      await cloud.cancel(a("owner"), (await cloud.detail(a("owner"), chat.id)).runs[0]!.id);
      const deleted = await personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "deleted", expectedRevision: restored.revision });
      expect(deleted.status).toBe("deleted");
      expect(new Date(deleted.purgeAfter!).getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
      await expect(personal().detail(a("owner"), project.id)).resolves.toMatchObject({ status: "deleted" });
      await expect(cloud.detail(a("owner"), chat.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(personal().references.list(a("owner"), project.id)).rejects.toMatchObject({ statusCode: 404 });
      expect((await personal().list(a("owner"), { status: "active", limit: 10 })).projects).toEqual([]);
      expect((await cloud.list(a("owner"), 10)).conversations).toEqual([]);
      const back = await personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "active", expectedRevision: deleted.revision });
      expect(back).toMatchObject({ status: "active", deletedAt: null, purgeAfter: null, conversationCount: 1 });
      expect((await cloud.detail(a("owner"), chat.id)).conversation.id).toBe(chat.id);
    });
    it("refuses to archive or delete while a chat is working, and rejects impossible transitions", async () => {
      const project = await make(a("owner"));
      const chat = await openChat(a("owner"), project.id);
      const sent = await send(a("owner"), chat.id, chat.revision);
      await expect(personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "deleted", expectedRevision: project.revision })).rejects.toMatchObject({ statusCode: 409, code: "personal_project_run_active" });
      await expect(personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "archived", expectedRevision: project.revision })).rejects.toMatchObject({ code: "personal_project_run_active" });
      await cloud.cancel(a("owner"), sent.run.id);
      const archived = await personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "archived", expectedRevision: project.revision });
      await expect(personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "archived", expectedRevision: 1 })).rejects.toMatchObject({ code: "personal_project_revision_conflict" });
      const deleted = await personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "deleted", expectedRevision: archived.revision });
      await expect(personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "archived", expectedRevision: deleted.revision })).rejects.toMatchObject({ code: "personal_project_transition_invalid" });
    });
    it("pauses the retention clock while a project is deleted", async () => {
      const project = await make(a("owner"));
      const chat = await openChat(a("owner"), project.id);
      await migration.query("UPDATE cloud_work_conversations SET updated_at=NOW()-INTERVAL '80 days' WHERE id=$1", [chat.id]);
      const deleted = await personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "deleted", expectedRevision: project.revision });
      await migration.query("UPDATE cloud_work_personal_projects SET deleted_at=NOW()-INTERVAL '20 days' WHERE id=$1", [project.id]);
      await personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "active", expectedRevision: deleted.revision });
      const idle = (await migration.query("SELECT EXTRACT(EPOCH FROM (NOW()-updated_at))/86400 AS days FROM cloud_work_conversations WHERE id=$1", [chat.id])).rows[0].days;
      expect(Number(idle)).toBeLessThan(65);
    });
  });

  describe("filing conversations", () => {
    it("moves a private chat into, between and out of projects without changing its identity or transcript", async () => {
      const one = await make(a("owner"), "One");
      const two = await make(a("owner"), "Two");
      const chat = await cloud.create(a("owner"), "Loose chat");
      const sent = await send(a("owner"), chat.id, chat.revision, "Remember this transcript");
      await cloud.cancel(a("owner"), sent.run.id);
      expect((await cloud.list(a("owner"), 20)).conversations.map((c) => c.id)).toEqual([chat.id]);
      const current = await cloud.detail(a("owner"), chat.id);
      const file = await cloud.files.upload(a("owner"), chat.id, "notes.txt", "text/plain", bytes("working file"), randomUUID());
      const filed = await personal().moveConversation(a("owner"), chat.id, { requestId: randomUUID(), personalProjectId: one.id, expectedRevision: current.conversation.revision });
      expect(filed).toMatchObject({ id: chat.id, personalProjectId: one.id });
      expect((await cloud.list(a("owner"), 20, undefined, undefined, undefined, "unfiled")).conversations).toEqual([]);
      expect((await cloud.list(a("owner"), 20)).conversations.map((c) => c.id)).toEqual([chat.id]);
      expect((await cloud.list(a("owner"), 20, undefined, undefined, one.id)).conversations.map((c) => c.id)).toEqual([chat.id]);
      const between = await personal().moveConversation(a("owner"), chat.id, { requestId: randomUUID(), personalProjectId: two.id, expectedRevision: filed.revision });
      expect(between.personalProjectId).toBe(two.id);
      expect((await cloud.list(a("owner"), 20, undefined, undefined, one.id)).conversations).toEqual([]);
      const out = await personal().moveConversation(a("owner"), chat.id, { requestId: randomUUID(), personalProjectId: null, expectedRevision: between.revision });
      expect(out.personalProjectId).toBeUndefined();
      expect((await cloud.list(a("owner"), 20)).conversations.map((c) => c.id)).toEqual([chat.id]);
      const after = await cloud.detail(a("owner"), chat.id);
      expect(after.messages.map((m) => m.text)).toEqual(current.messages.map((m) => m.text));
      expect(after.files.map((f) => f.id)).toEqual([file.id]);
      expect(after.runs.map((r) => r.id)).toEqual(current.runs.map((r) => r.id));
      expect((await personal().detail(a("owner"), one.id)).conversationCount).toBe(0);
    });
    it("replays a move, refuses a stale revision and a working chat, and ignores a no-op", async () => {
      const project = await make(a("owner"));
      const chat = await cloud.create(a("owner"), "Chat");
      const request = { requestId: randomUUID(), personalProjectId: project.id, expectedRevision: chat.revision };
      const moved = await personal().moveConversation(a("owner"), chat.id, request);
      expect((await personal().moveConversation(a("owner"), chat.id, request)).revision).toBe(moved.revision);
      await expect(personal().moveConversation(a("owner"), chat.id, { ...request, requestId: randomUUID() })).rejects.toMatchObject({ code: "cloud_revision_conflict" });
      await expect(personal().moveConversation(a("owner"), chat.id, { ...request, personalProjectId: null })).rejects.toMatchObject({ code: "personal_project_idempotency_conflict" });
      const same = await personal().moveConversation(a("owner"), chat.id, { requestId: randomUUID(), personalProjectId: project.id, expectedRevision: moved.revision });
      expect(same.revision).toBe(moved.revision);
      const sent = await send(a("owner"), chat.id, moved.revision);
      await expect(personal().moveConversation(a("owner"), chat.id, { requestId: randomUUID(), personalProjectId: null, expectedRevision: sent.conversation.revision })).rejects.toMatchObject({ code: "cloud_run_active" });
      await cloud.cancel(a("owner"), sent.run.id);
    });
    it("refuses archived and deleted targets and foreign projects, and still moves a chat out of an archived project", async () => {
      await policy({ allowAll: true });
      const mine = await make(a("owner"), "Mine");
      const theirs = await make(a("alice"), "Theirs");
      const chat = await cloud.create(a("owner"), "Chat");
      await expect(personal().moveConversation(a("owner"), chat.id, { requestId: randomUUID(), personalProjectId: theirs.id, expectedRevision: chat.revision })).rejects.toMatchObject({ code: "personal_project_not_found" });
      const filed = await personal().moveConversation(a("owner"), chat.id, { requestId: randomUUID(), personalProjectId: mine.id, expectedRevision: chat.revision });
      const archived = await personal().lifecycle(a("owner"), mine.id, { requestId: randomUUID(), status: "archived", expectedRevision: mine.revision });
      const loose = await cloud.create(a("owner"), "Loose");
      await expect(personal().moveConversation(a("owner"), loose.id, { requestId: randomUUID(), personalProjectId: mine.id, expectedRevision: loose.revision })).rejects.toMatchObject({ code: "personal_project_archived" });
      const out = await personal().moveConversation(a("owner"), chat.id, { requestId: randomUUID(), personalProjectId: null, expectedRevision: filed.revision });
      expect(out.id).toBe(chat.id);
      const deleted = await personal().lifecycle(a("owner"), mine.id, { requestId: randomUUID(), status: "deleted", expectedRevision: archived.revision });
      await expect(personal().moveConversation(a("owner"), loose.id, { requestId: randomUUID(), personalProjectId: mine.id, expectedRevision: loose.revision })).rejects.toMatchObject({ code: "personal_project_not_found" });
      expect(deleted.status).toBe("deleted");
    });
    it("enforces ownership and exclusivity in the database itself", async () => {
      await policy({ allowAll: true });
      const mine = await make(a("owner"));
      const theirs = await make(a("alice"));
      const chat = await cloud.create(a("owner"), "Chat");
      await expect(migration.query("UPDATE cloud_work_conversations SET personal_project_id=$2 WHERE id=$1", [chat.id, theirs.id])).rejects.toMatchObject({ code: "23503" });
      await expect(migration.query("UPDATE cloud_work_personal_projects SET member_id='bob-member' WHERE id=$1", [mine.id])).rejects.toMatchObject({ code: "23514" });
      await expect(migration.query("UPDATE cloud_work_personal_projects SET organization_id='other' WHERE id=$1", [mine.id])).rejects.toBeTruthy();
      const team = randomUUID();
      await migration.query("INSERT INTO cloud_work_projects(id,organization_id,content,wrapped_key,policy) VALUES($1,'org','{\"$project\":\"1\"}','{\"$project\":\"1\"}','{}')", [team]);
      await expect(migration.query(
        "INSERT INTO cloud_work_conversations(id,organization_id,member_id,project_id,title,personal_project_id) VALUES($1,'org',NULL,$2,'lori-project:1:x',$3)",
        [randomUUID(), team, mine.id],
      )).rejects.toMatchObject({ code: "23514" });
      await expect(migration.query("UPDATE cloud_work_conversations SET project_id=$2 WHERE id=$1", [chat.id, team])).rejects.toBeTruthy();
      const filed = await personal().moveConversation(a("owner"), chat.id, { requestId: randomUUID(), personalProjectId: mine.id, expectedRevision: chat.revision });
      await expect(migration.query("UPDATE cloud_work_conversations SET project_id=$2,member_id=NULL WHERE id=$1", [filed.id, team])).rejects.toMatchObject({ code: "23514" });
    });
    it("keeps team-workspace conversations out of personal projects", async () => {
      const project = await make(a("owner"));
      const team = randomUUID();
      await migration.query("INSERT INTO cloud_work_projects(id,organization_id,content,wrapped_key,policy) VALUES($1,'org','{\"$project\":\"1\"}','{\"$project\":\"1\"}','{}')", [team]);
      await expect(personal().moveConversation(a("owner"), team, { requestId: randomUUID(), personalProjectId: project.id, expectedRevision: 1 })).rejects.toMatchObject({ statusCode: 404 });
      await expect(cloud.list({ ...a("owner") }, 10, undefined, team, project.id)).rejects.toMatchObject({ code: "personal_project_scope" });
    });
  });

  describe("reference files", () => {
    it("uploads, lists, downloads, previews text and rejects duplicates, bad names and wrong projects", async () => {
      const project = await make(a("owner"));
      const other = await make(a("owner"), "Other");
      const reference = await upload(a("owner"), project.id, "Style Guide.md", "# Style\nUse short sentences.\n", "text/markdown");
      expect(reference).toMatchObject({ projectId: project.id, name: "Style Guide.md", version: 1, sizeBytes: 29 });
      expect((await personal().references.list(a("owner"), project.id)).references.map((r) => r.name)).toEqual(["Style Guide.md"]);
      const download = await personal().references.download(a("owner"), reference.id);
      expect(download.bytes.toString()).toBe("# Style\nUse short sentences.\n");
      const text = await personal().references.text(a("owner"), reference.id, 2, 10, 0);
      expect(text.text).toBe("Use short sentences.\n");
      await expect(upload(a("owner"), project.id, "style guide.MD", "again")).rejects.toMatchObject({ statusCode: 409, code: "personal_project_reference_exists" });
      expect((await upload(a("owner"), other.id, "Style Guide.md", "same name, other project")).projectId).toBe(other.id);
      for (const name of ["", "a/b.txt", "..", "bad\nname", ".lori-hidden", "x".repeat(201), "back\\slash"])
        await expect(upload(a("owner"), project.id, name, "x")).rejects.toMatchObject({ code: "personal_project_reference_name_invalid" });
      const request = randomUUID();
      const input = { name: "once.txt", mimeType: "text/plain", bytes: bytes("one"), requestId: request };
      const first = await personal().references.upload(a("owner"), project.id, input);
      expect((await personal().references.upload(a("owner"), project.id, input)).id).toBe(first.id);
      await expect(personal().references.upload(a("owner"), project.id, { ...input, bytes: bytes("two") })).rejects.toMatchObject({ code: "personal_project_idempotency_conflict" });
    });
    it("replaces with immutable versions, detects stale writers, prunes old versions and keeps a hash chain", async () => {
      const project = await make(a("owner"));
      let reference = await upload(a("owner"), project.id, "data.txt", "v1");
      const original = reference;
      await expect(personal().references.replace(a("owner"), reference.id, { bytes: bytes("x"), expectedVersion: 7, expectedHash: reference.sha256, requestId: randomUUID() })).rejects.toMatchObject({ code: "personal_project_reference_conflict" });
      await expect(personal().references.replace(a("owner"), reference.id, { bytes: bytes("x"), expectedVersion: 1, expectedHash: bytesHash(bytes("other")), requestId: randomUUID() })).rejects.toMatchObject({ code: "personal_project_reference_conflict" });
      for (let i = 2; i <= 13; i++)
        reference = await personal().references.replace(a("owner"), reference.id, { bytes: bytes(`v${i}`), expectedVersion: reference.version, expectedHash: reference.sha256, requestId: randomUUID() });
      expect(reference).toMatchObject({ version: 13, sizeBytes: 3 });
      expect((await personal().references.download(a("owner"), reference.id)).bytes.toString()).toBe("v13");
      const versions = (await migration.query("SELECT version FROM cloud_work_personal_project_reference_versions WHERE reference_id=$1 ORDER BY version", [reference.id])).rows.map((r) => r.version);
      expect(versions).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      await expect(migration.query("UPDATE cloud_work_personal_project_reference_versions SET sha256='x' WHERE reference_id=$1", [reference.id])).rejects.toMatchObject({ code: "23514" });
      expect(original.sha256).not.toBe(reference.sha256);
    });
    it("enforces the 20 MiB file, 100 file and 100 MiB project limits, counting retained versions", async () => {
      const project = await make(a("owner"));
      await expect(upload(a("owner"), project.id, "huge.bin", Buffer.alloc(20 * 1024 * 1024 + 1), "application/octet-stream")).rejects.toMatchObject({ statusCode: 413 });
      const full = Buffer.alloc(20 * 1024 * 1024, 7);
      const stored = [];
      for (let i = 0; i < 5; i++) stored.push(await upload(a("owner"), project.id, `big-${i}.bin`, full, "application/octet-stream"));
      await expect(upload(a("owner"), project.id, "one-more.txt", "x")).rejects.toMatchObject({ statusCode: 413, code: "personal_project_reference_quota" });
      await expect(personal().references.replace(a("owner"), stored[0]!.id, { bytes: bytes("small"), expectedVersion: 1, expectedHash: stored[0]!.sha256, requestId: randomUUID() })).rejects.toMatchObject({ code: "personal_project_reference_quota" });
      await personal().references.remove(a("owner"), stored[4]!.id, 1, stored[4]!.sha256);
      await expect(upload(a("owner"), project.id, "fits-now.txt", "x")).resolves.toMatchObject({ version: 1 });
      const crowded = await make(a("owner"), "Crowded");
      for (let i = 0; i < 100; i++) await upload(a("owner"), crowded.id, `f${i}.txt`, "x");
      await expect(upload(a("owner"), crowded.id, "f100.txt", "x")).rejects.toMatchObject({ code: "personal_project_reference_quota" });
    }, 60000);
    it("verifies stored bytes by hash and recovers blobs only when nothing references them", async () => {
      const project = await make(a("owner"));
      const kept = await upload(a("owner"), project.id, "kept.txt", "kept bytes");
      const gone = await upload(a("owner"), project.id, "gone.txt", "gone bytes");
      const blobs = async () => (await readdir(resolve(directory, "files"))).filter((n) => /^[0-9a-f-]{36}$/.test(n));
      const keys = (await migration.query("SELECT reference_id,storage_key FROM cloud_work_personal_project_reference_versions")).rows;
      const key = (id: string) => keys.find((k) => k.reference_id === id)!.storage_key as string;
      await personal().references.remove(a("owner"), gone.id, 1, gone.sha256);
      const orphan = randomUUID();
      await writeFile(resolve(directory, "files", orphan), "stray", { mode: 0o600 });
      for (const name of await blobs()) await utimes(resolve(directory, "files", name), new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
      for (let i = 0; i < 4; i++) await cloud.files.cleanup();
      const left = await blobs();
      expect(left).toContain(key(kept.id));
      expect(left).not.toContain(key(gone.id));
      expect(left).not.toContain(orphan);
      await writeFile(resolve(directory, "files", key(kept.id)), "tampered");
      await expect(personal().references.download(a("owner"), kept.id)).rejects.toMatchObject({ statusCode: 503 });
    });
    it("is invisible to working-file tools, listings and uploads of any conversation", async () => {
      const project = await make(a("owner"));
      const chat = await openChat(a("owner"), project.id);
      const reference = await upload(a("owner"), project.id, "readonly.txt", "reference body");
      expect((await cloud.files.list(a("owner"), chat.id)).files).toEqual([]);
      await expect(cloud.files.download(a("owner"), reference.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(cloud.files.text(a("owner"), reference.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(cloud.files.remove(a("owner"), reference.id, 1, reference.sha256)).rejects.toMatchObject({ statusCode: 404 });
      await expect(cloud.files.edit(a("owner"), reference.id, { text: "overwritten", expectedVersion: 1, expectedHash: reference.sha256, requestId: randomUUID() })).rejects.toMatchObject({ statusCode: 404 });
      // The same path in the conversation creates an independent working file.
      const working = await cloud.files.upload(a("owner"), chat.id, "readonly.txt", "text/plain", bytes("working copy"), randomUUID());
      expect(working.id).not.toBe(reference.id);
      expect((await personal().references.download(a("owner"), reference.id)).bytes.toString()).toBe("reference body");
    });
    it("serves page previews for references through the shared preview queue and removes them with the reference", async () => {
      const project = await make(a("owner"));
      const reference = await upload(a("owner"), project.id, "slides.pdf", Buffer.from("%PDF-1.4 test"), "application/pdf");
      const pages = [randomUUID(), randomUUID()];
      for (const [index, id] of pages.entries())
        await migration.query("INSERT INTO cloud_work_file_previews(id,file_id,file_version,sha256,page,status,priority) VALUES($1,$2,$3,$4,$5,'queued',0)", [id, reference.id, reference.version, reference.sha256, index + 1]);
      const sources = (await migration.query("SELECT path FROM cloud_work_preview_sources WHERE id=$1", [reference.id])).rows;
      expect(sources).toEqual([{ path: "slides.pdf" }]);
      expect((await migration.query("SELECT storage_key FROM cloud_work_preview_source_versions WHERE file_id=$1", [reference.id])).rowCount).toBe(1);
      await personal().references.remove(a("owner"), reference.id, 1, reference.sha256);
      expect((await migration.query("SELECT 1 FROM cloud_work_file_previews WHERE file_id=$1", [reference.id])).rowCount).toBe(0);
    });
  });

  describe("turn context", () => {
    async function claimed(actor: CloudActor, conversationId: string, text = "Summarize the plan") {
      const conversation = await cloud.detail(actor, conversationId);
      const sent = await send(actor, conversationId, conversation.conversation.revision, text);
      const claim = (await cloud.claim("personal-worker", { tools: true }))!;
      expect(claim).not.toBeNull();
      return { sent, claim, claims: cloud.claims(`Bearer ${claim.leaseToken}`, sent.run.id) };
    }
    const round = async (q: Awaited<ReturnType<typeof claimed>>, index: number, name: string, args: Record<string, unknown>) => {
      const roundId = randomUUID();
      await cloud.rounds.begin(q.claims, roundId, index, { model: "test-model", stream: true });
      const call = { id: `call-${index + 1}`, name, arguments: args };
      await cloud.rounds.receipt(q.claims, roundId, {
        roundIndex: index,
        assistant: { role: "assistant", text: "", native: { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } },
        toolCalls: [call],
      });
      return { roundId, call };
    };

    it("gives every round the saved instructions and reference manifest, and the plain-chat path the same text", async () => {
      const project = await make(a("owner"), "Board prep");
      await personal().update(a("owner"), project.id, { expectedRevision: project.revision, instructions: "Always answer in French." });
      const reference = await upload(a("owner"), project.id, "agenda.txt", "1. Opening\n2. Budget\n");
      const chat = await openChat(a("owner"), project.id);
      const q = await claimed(a("owner"), chat.id);
      const prepared = await cloud.rounds.begin(q.claims, randomUUID(), 0, { model: "test-model", stream: true });
      const messages = prepared.body.messages as { role: string; content: string }[];
      const system = messages[0]!.content;
      expect(system).toContain("Always answer in French.");
      expect(system).toContain("subordinate to the rules above");
      expect(system).toContain(reference.id);
      expect(system).toContain("agenda.txt");
      expect(system).toContain("read_project_reference");
      expect(JSON.stringify(prepared.body.tools)).toContain("copy_project_reference");
      // Plain chat: one resolver, the same instructions and manifest, without tool instructions.
      const plain = await personal().context.resolveForRun({ organization_id: "org", member_id: "owner-member", conversation_id: chat.id });
      expect(plain).toContain("Always answer in French.");
      expect(plain).toContain(reference.id);
      expect(plain).not.toContain("read_project_reference");
      const loose = await cloud.create(a("owner"), "Loose");
      expect(await personal().context.resolveForRun({ organization_id: "org", member_id: "owner-member", conversation_id: loose.id })).toBeNull();
      await cloud.cancel(a("owner"), q.sent.run.id);
    });
    it("sends updated instructions on the next turn and fails closed when the project is unreadable", async () => {
      const project = await make(a("owner"));
      const chat = await openChat(a("owner"), project.id);
      const first = await claimed(a("owner"), chat.id);
      await personal().update(a("owner"), project.id, { expectedRevision: project.revision, instructions: "Use the new house style." });
      const prepared = await cloud.rounds.begin(first.claims, randomUUID(), 0, { model: "test-model", stream: true });
      expect((prepared.body.messages as { content: string }[])[0]!.content).toContain("Use the new house style.");
      await cloud.cancel(a("owner"), first.sent.run.id);
      const second = await claimed(a("owner"), chat.id, "Another question");
      await migration.query("UPDATE cloud_work_personal_projects SET status='deleted',deleted_at=NOW(),purge_after=NOW()+INTERVAL '1 day' WHERE id=$1", [project.id]);
      await expect(cloud.rounds.begin(second.claims, randomUUID(), 0, { model: "test-model", stream: true })).rejects.toMatchObject({ statusCode: 404 });
      await expect(cloud.snapshot(a("owner"), second.sent.run.id)).rejects.toMatchObject({ statusCode: 404 });
    });
    it("excludes account-wide memory, other projects and other conversations, and offers no reference tools to unfiled chats", async () => {
      const project = await make(a("owner"), "Memory boundary");
      const other = await make(a("owner"), "Other");
      const chat = await openChat(a("owner"), project.id);
      const sibling = await openChat(a("owner"), project.id, "Sibling");
      const loose = await cloud.create(a("owner"), "Loose");
      await cloud.memory.create(a("owner"), { requestId: randomUUID(), scope: "personal", topic: "Diet", content: "PERSONAL-NOTE-LEAK" });
      await cloud.memory.create(a("owner"), { requestId: randomUUID(), scope: "conversation", conversationId: chat.id, topic: "Scope", content: "THIS-CHAT-NOTE" });
      await cloud.memory.create(a("owner"), { requestId: randomUUID(), scope: "conversation", conversationId: sibling.id, topic: "Other chat", content: "SIBLING-NOTE-LEAK" });
      await upload(a("owner"), other.id, "other.txt", "x");
      const filed = await claimed(a("owner"), chat.id);
      const inside = await cloud.rounds.begin(filed.claims, randomUUID(), 0, { model: "test-model", stream: true });
      const text = JSON.stringify(inside.body.messages);
      expect(text).toContain("THIS-CHAT-NOTE");
      expect(text).not.toContain("PERSONAL-NOTE-LEAK");
      expect(text).not.toContain("SIBLING-NOTE-LEAK");
      expect(text).not.toContain("other.txt");
      expect(JSON.stringify(inside.body.tools)).toContain("list_project_references");
      await cloud.cancel(a("owner"), filed.sent.run.id);
      const unfiled = await claimed(a("owner"), loose.id);
      const outside = await cloud.rounds.begin(unfiled.claims, randomUUID(), 0, { model: "test-model", stream: true });
      expect(JSON.stringify(outside.body.messages)).toContain("PERSONAL-NOTE-LEAK");
      expect(JSON.stringify(outside.body.tools)).not.toContain("list_project_references");
      await cloud.cancel(a("owner"), unfiled.sent.run.id);
    });
    it("fails account-wide memory writes clearly inside a project and confines memory reads to the chat", async () => {
      const project = await make(a("owner"));
      const chat = await openChat(a("owner"), project.id);
      await cloud.memory.create(a("owner"), { requestId: randomUUID(), scope: "personal", topic: "Account", content: "ACCOUNT-WIDE" });
      const personalNote = (await cloud.memory.list(a("owner"), { scope: "personal" })).notes[0]!;
      const q = await claimed(a("owner"), chat.id);
      const write = await round(q, 0, "memory_update", { scope: "personal", topic: "Leak", content: "should never save" });
      const refused = await cloud.tools.request(q.claims, { requestId: randomUUID(), ...write });
      expect(refused.status).toBe("failed");
      expect(JSON.stringify(refused.output)).toContain("personal_project_memory_scope");
      expect((await cloud.memory.list(a("owner"), { scope: "personal" })).notes.map((n) => n.topic)).toEqual(["Account"]);
      const search = await round(q, 1, "memory_search", { query: "ACCOUNT-WIDE", scope: "personal" });
      expect(JSON.stringify((await cloud.tools.request(q.claims, { requestId: randomUUID(), ...search })).output)).toContain("personal_project_memory_scope");
      const unscoped = await round(q, 2, "memory_search", { query: "ACCOUNT-WIDE" });
      const found = await cloud.tools.request(q.claims, { requestId: randomUUID(), ...unscoped });
      expect(found.status).toBe("completed");
      expect(JSON.stringify(found.output)).not.toContain("ACCOUNT-WIDE");
      const read = await round(q, 3, "memory_read", { id: personalNote.id });
      expect((await cloud.tools.request(q.claims, { requestId: randomUUID(), ...read })).status).toBe("failed");
      await cloud.cancel(a("owner"), q.sent.run.id);
    });
    it("lets a chat list and read references, and copy one into its workspace only after approval, leaving the reference untouched", async () => {
      const project = await make(a("owner"));
      const text = await upload(a("owner"), project.id, "brief.txt", "Line one\nLine two\n");
      const binary = await upload(a("owner"), project.id, "deck.pptx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80]), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
      const chat = await openChat(a("owner"), project.id);
      const q = await claimed(a("owner"), chat.id);
      const listed = await cloud.tools.request(q.claims, { requestId: randomUUID(), ...(await round(q, 0, "list_project_references", {})) });
      expect(listed.status).toBe("completed");
      expect((listed.output as { references: { name: string }[] }).references.map((r) => r.name).sort()).toEqual(["brief.txt", "deck.pptx"]);
      const read = await cloud.tools.request(q.claims, { requestId: randomUUID(), ...(await round(q, 1, "read_project_reference", { referenceId: text.id })) });
      expect(read.status).toBe("completed");
      expect(JSON.stringify(read.output)).toContain("1: Line one");
      const notText = await cloud.tools.request(q.claims, { requestId: randomUUID(), ...(await round(q, 2, "read_project_reference", { referenceId: binary.id })) });
      expect(notText.status).toBe("failed");
      expect(JSON.stringify(notText.output)).toContain("copy_project_reference");
      const foreign = await cloud.tools.request(q.claims, { requestId: randomUUID(), ...(await round(q, 3, "read_project_reference", { referenceId: randomUUID() })) });
      expect(foreign.status).toBe("failed");
      const copy = await cloud.tools.request(q.claims, { requestId: randomUUID(), ...(await round(q, 4, "copy_project_reference", { referenceId: text.id, path: "working/brief-copy.txt" })) });
      expect(copy.status).toBe("pendingApproval");
      expect((await cloud.files.list(a("owner"), chat.id)).files).toEqual([]);
      const snapshot = await cloud.snapshot(a("owner"), q.sent.run.id);
      const approval = snapshot.approvals![0]!;
      await cloud.tools.decide(a("owner"), q.sent.run.id, approval.id, { requestId: randomUUID(), actionHash: approval.actionHash, decision: "approve" });
      const files = (await cloud.files.list(a("owner"), chat.id)).files;
      expect(files.map((f) => f.path)).toEqual(["working/brief-copy.txt"]);
      expect(files[0]!.id).not.toBe(text.id);
      // The working copy is independent: changing it never changes the reference.
      await cloud.files.edit(a("owner"), files[0]!.id, { text: "edited copy", expectedVersion: files[0]!.version, expectedHash: files[0]!.sha256, requestId: randomUUID() });
      expect((await personal().references.download(a("owner"), text.id)).bytes.toString()).toBe("Line one\nLine two\n");
      expect((await personal().references.get(a("owner"), text.id)).version).toBe(1);
      const clash = await cloud.tools.request(q.claims, { requestId: randomUUID(), ...(await round(q, 5, "copy_project_reference", { referenceId: text.id, path: "working/brief-copy.txt" })) });
      expect(clash.status).toBe("failed");
      await cloud.cancel(a("owner"), q.sent.run.id);
    });
    it("refuses reference tools in an unfiled chat and for another project's reference", async () => {
      const mine = await make(a("owner"), "Mine");
      const other = await make(a("owner"), "Other");
      const foreignReference = await upload(a("owner"), other.id, "other.txt", "other");
      const loose = await cloud.create(a("owner"), "Loose");
      const unfiled = await claimed(a("owner"), loose.id);
      const call = await round(unfiled, 0, "list_project_references", {});
      await expect(cloud.tools.request(unfiled.claims, { requestId: randomUUID(), ...call })).rejects.toMatchObject({ statusCode: 403, code: "cloud_tool_unavailable" });
      await cloud.cancel(a("owner"), unfiled.sent.run.id);
      const chat = await openChat(a("owner"), mine.id);
      const q = await claimed(a("owner"), chat.id);
      const read = await cloud.tools.request(q.claims, { requestId: randomUUID(), ...(await round(q, 0, "read_project_reference", { referenceId: foreignReference.id })) });
      expect(read.status).toBe("failed");
      expect(JSON.stringify(read.output)).not.toContain("other");
      await cloud.cancel(a("owner"), q.sent.run.id);
    });
  });

  describe("HTTP API", () => {
    const ROOT = "/v1/work/cloud/personal-projects";
    const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, extra: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { origin, ...extra }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
    const raw = (method: "POST" | "PUT", url: string, body: Buffer, extra: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { origin, "content-type": "application/octet-stream", ...extra }, payload: body });

    it("creates, reads, updates and moves through validated, origin-checked endpoints", async () => {
      const created = await call("POST", ROOT, { requestId: randomUUID(), name: "  HTTP project  ", instructions: "Be brief." });
      expect(created.statusCode).toBe(201);
      const project = created.json();
      expect(project).toMatchObject({ name: "HTTP project", instructions: "Be brief.", status: "active" });
      expect((await app.inject({ method: "POST", url: ROOT, headers: { origin: "https://evil.example" }, payload: { requestId: randomUUID(), name: "Nope" } })).statusCode).toBe(403);
      expect((await call("POST", ROOT, { requestId: randomUUID(), name: "Extra", owner: "alice-member" })).statusCode).toBe(400);
      expect((await call("POST", ROOT, { name: "No request id" })).statusCode).toBe(400);
      expect((await call("POST", ROOT, { requestId: randomUUID(), name: "x".repeat(101) })).statusCode).toBe(400);
      expect((await call("GET", ROOT)).json().projects.map((p: { id: string }) => p.id)).toEqual([project.id]);
      expect((await call("GET", `${ROOT}?status=bogus`)).statusCode).toBe(400);
      expect((await call("GET", `${ROOT}/capabilities`)).json()).toMatchObject({ available: true, canCreate: true });
      const patched = await call("PATCH", `${ROOT}/${project.id}`, { expectedRevision: project.revision, name: "Renamed" });
      expect(patched.json()).toMatchObject({ name: "Renamed", revision: project.revision + 1 });
      expect((await call("PATCH", `${ROOT}/${project.id}`, { expectedRevision: project.revision, name: "Stale" })).statusCode).toBe(409);
      const chat = await call("POST", `${ROOT}/${project.id}/conversations`, { title: "From HTTP" });
      expect(chat.statusCode).toBe(201);
      expect(chat.json().personalProjectId).toBe(project.id);
      expect((await call("GET", `${ROOT}/${project.id}/conversations`)).json().conversations).toHaveLength(1);
      expect((await call("GET", "/v1/work/cloud/conversations?placement=unfiled")).json().conversations).toEqual([]);
      const everything = (await call("GET", "/v1/work/cloud/conversations")).json().conversations;
      expect(everything.map((c: { id: string }) => c.id)).toEqual([chat.json().id]);
      expect(everything[0].personalProjectId).toBe(project.id);
      expect((await call("GET", "/v1/work/cloud/conversations?placement=bogus")).statusCode).toBe(400);
      const out = await call("PUT", `/v1/work/cloud/conversations/${chat.json().id}/personal-project`, { requestId: randomUUID(), personalProjectId: null, expectedRevision: chat.json().revision });
      expect(out.statusCode).toBe(200);
      expect(out.json().personalProjectId).toBeUndefined();
      expect((await call("GET", "/v1/work/cloud/conversations?placement=unfiled")).json().conversations.map((c: { id: string }) => c.id)).toEqual([chat.json().id]);
      expect((await call("PUT", `/v1/work/cloud/conversations/${chat.json().id}/personal-project`, { requestId: randomUUID(), personalProjectId: "not-a-uuid", expectedRevision: 1 })).statusCode).toBe(400);
      const lifecycle = await call("POST", `${ROOT}/${project.id}/lifecycle`, { requestId: randomUUID(), status: "deleted", expectedRevision: patched.json().revision });
      expect(lifecycle.json().status).toBe("deleted");
      expect((await call("GET", `${ROOT}?status=deleted`)).json().projects).toHaveLength(1);
      session = "alice";
      expect((await call("GET", `${ROOT}/${project.id}`)).statusCode).toBe(404);
      expect((await call("GET", `${ROOT}/${randomUUID()}`)).statusCode).toBe(404);
    });
    it("transfers reference files with strict content types, versions and project scoping", async () => {
      const project = await make(a("owner"));
      const other = await make(a("owner"), "Other");
      const url = `${ROOT}/${project.id}/references`;
      const q = (name: string, extra = "") => `${url}?name=${encodeURIComponent(name)}&requestId=${randomUUID()}&mimeType=text/plain${extra}`;
      expect((await call("POST", q("a.txt"), "{}" as unknown as object)).statusCode).toBe(415);
      expect((await raw("POST", q("a.txt"), bytes("alpha"), { origin: "https://evil.example" })).statusCode).toBe(403);
      const uploaded = await raw("POST", q("../a.txt"), bytes("alpha"));
      expect(uploaded.statusCode).toBe(400);
      const ok = await raw("POST", q("a.txt"), bytes("alpha\nbeta\n"));
      expect(ok.statusCode).toBe(201);
      const reference = ok.json();
      const content = await call("GET", `${url}/${reference.id}/content`);
      expect(content.body).toBe("alpha\nbeta\n");
      expect(content.headers["x-content-type-options"]).toBe("nosniff");
      expect(content.headers["content-disposition"]).toContain("a.txt");
      expect(content.headers.etag).toBe(`"${reference.sha256}"`);
      expect((await call("GET", `${url}/${reference.id}/text?startLine=2`)).json().text).toBe("beta\n");
      expect((await call("GET", `${ROOT}/${other.id}/references/${reference.id}`)).statusCode).toBe(404);
      expect((await call("GET", `${ROOT}/${other.id}/references/${reference.id}/content`)).statusCode).toBe(404);
      const replaced = await raw("PUT", `${url}/${reference.id}/content?requestId=${randomUUID()}&expectedVersion=1&expectedHash=${reference.sha256}`, bytes("gamma"));
      expect(replaced.json()).toMatchObject({ version: 2, sizeBytes: 5 });
      expect((await raw("PUT", `${url}/${reference.id}/content?requestId=${randomUUID()}&expectedVersion=1&expectedHash=${reference.sha256}`, bytes("late"))).statusCode).toBe(409);
      expect((await call("GET", `${url}/${reference.id}/preview?hash=${replaced.json().sha256}`)).statusCode).toBe(415);
      expect((await call("DELETE", `${url}/${reference.id}?expectedVersion=1&expectedHash=${reference.sha256}`)).statusCode).toBe(409);
      expect((await call("DELETE", `${url}/${reference.id}?expectedVersion=2&expectedHash=${replaced.json().sha256}`)).statusCode).toBe(204);
      expect((await call("GET", `${url}/${reference.id}`)).statusCode).toBe(404);
      session = "alice";
      expect((await call("GET", url)).statusCode).toBe(404);
    });
    it("shows the preview pipeline a reference exactly as it shows a working file", async () => {
      const project = await make(a("owner"));
      const reference = await upload(a("owner"), project.id, "report.pdf", Buffer.from("%PDF-1.4 fake"), "application/pdf");
      const url = `${ROOT}/${project.id}/references/${reference.id}/preview`;
      expect((await call("GET", `${url}?hash=${bytesHash(bytes("stale"))}`)).statusCode).toBe(409);
      // No preview worker is online in this test: the request is refused as unavailable, not as missing or foreign.
      expect((await call("GET", `${url}?hash=${reference.sha256}`)).statusCode).toBe(503);
      expect((await call("GET", `${url}/image?hash=${reference.sha256}`)).statusCode).toBe(404);
      session = "alice";
      expect((await call("GET", `${url}?hash=${reference.sha256}`)).statusCode).toBe(404);
    });
    it("administers the creation policy only through an administrator session", async () => {
      const current = (await call("GET", `${ROOT}/policy`)).json();
      expect(current).toMatchObject({ allowAll: false, grants: [], blockedMemberIds: [], maxPerMember: null, defaultMaxPerMember: 100 });
      const body = { expectedRevision: current.revision, allowAll: true, grants: [{ kind: "team", subjectId: "team-a" }], blockedMemberIds: ["carol-member"], maxPerMember: 5 };
      expect((await call("PUT", `${ROOT}/policy`, { ...body, extra: 1 })).statusCode).toBe(400);
      expect((await call("PUT", `${ROOT}/policy`, { ...body, maxPerMember: 0 })).statusCode).toBe(400);
      const saved = await call("PUT", `${ROOT}/policy`, body);
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ allowAll: true, maxPerMember: 5, blockedMemberIds: ["carol-member"], revision: current.revision + 1 });
      expect((await call("PUT", `${ROOT}/policy`, body)).statusCode).toBe(409);
      expect((await call("GET", `${ROOT}/policy/effective?memberId=carol-member`)).json()).toMatchObject({ allowed: false, source: "blocked" });
      expect((await call("GET", `${ROOT}/policy/effective?memberId=alice-member`)).json()).toMatchObject({ allowed: true, source: "everyone" });
      expect((await call("GET", `${ROOT}/directory`)).json().teams).toEqual([{ id: "team-a", name: "Analysts" }]);
      session = "alice";
      for (const [method, url] of [["GET", `${ROOT}/policy`], ["GET", `${ROOT}/directory`], ["GET", `${ROOT}/policy/effective?memberId=bob-member`]] as const)
        expect((await call(method, url)).statusCode).toBe(403);
      expect((await call("PUT", `${ROOT}/policy`, { ...body, expectedRevision: saved.json().revision })).statusCode).toBe(403);
    });
    it("gives the plain-chat provider path the same project context as agent rounds", async () => {
      const project = await make(a("owner"), "Plain chat");
      await personal().update(a("owner"), project.id, { expectedRevision: project.revision, instructions: "Respond like a pirate." });
      const reference = await upload(a("owner"), project.id, "map.txt", "treasure");
      const chat = await openChat(a("owner"), project.id);
      const sent = await send(a("owner"), chat.id, chat.revision, "Ahoy");
      const claim = (await cloud.claim("plain-worker", {}))!;
      const captured: Record<string, unknown>[] = [];
      vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
        captured.push(JSON.parse(String(init.body)));
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"text":"ok"}\n\n')); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
      });
      try {
        const response = await app.inject({ method: "POST", url: `/v1/internal/work/cloud/runs/${sent.run.id}/provider`, headers: { authorization: `Bearer ${claim.leaseToken}` }, payload: { body: { model: "test-model", stream: true } } });
        expect(response.statusCode).toBe(200);
      } finally {
        vi.unstubAllGlobals();
      }
      const system = (captured[0]!.messages as { role: string; content: string }[])[0]!;
      expect(system.role).toBe("system");
      expect(system.content).toContain("Respond like a pirate.");
      expect(system.content).toContain(reference.id);
      expect(system.content).toContain("Tools and file access are unavailable");
      expect(captured[0]!.tools).toBeUndefined();
      await cloud.cancel(a("owner"), sent.run.id);
    });
  });

  describe("indirect access", () => {
    it("drops notifications, runs, events and files of a deleted project's chats, and restores them with the project", async () => {
      const project = await make(a("owner"));
      const chat = await openChat(a("owner"), project.id);
      const file = await cloud.files.upload(a("owner"), chat.id, "kept.txt", "text/plain", bytes("body"), randomUUID());
      const sent = await send(a("owner"), chat.id, chat.revision);
      await migration.query("UPDATE cloud_work_runs SET status='failed' WHERE id=$1", [sent.run.id]);
      const since = { since: new Date(Date.now() - 60_000).toISOString() };
      const notified = async () => (await notifications(cloud, a("owner"), since)).events.some((event) => event.runId === sent.run.id);
      expect(await notified()).toBe(true);
      const deleted = await personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "deleted", expectedRevision: project.revision });
      expect(await notified()).toBe(false);
      await expect(cloud.snapshot(a("owner"), sent.run.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(cloud.events(a("owner"), sent.run.id, 0)).rejects.toMatchObject({ statusCode: 404 });
      await expect(cloud.cancel(a("owner"), sent.run.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(cloud.files.download(a("owner"), file.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(cloud.files.list(a("owner"), chat.id)).rejects.toMatchObject({ statusCode: 404 });
      await personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "active", expectedRevision: deleted.revision });
      expect(await notified()).toBe(true);
      expect((await cloud.files.download(a("owner"), file.id)).bytes.toString()).toBe("body");
      expect((await cloud.events(a("owner"), sent.run.id, 0)).run.id).toBe(sent.run.id);
    });
    it("blocks new work in an archived project's chats but still lets the owner read and delete them", async () => {
      const project = await make(a("owner"));
      const chat = await openChat(a("owner"), project.id);
      await personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "archived", expectedRevision: project.revision });
      await expect(cloud.files.upload(a("owner"), chat.id, "new.txt", "text/plain", bytes("x"), randomUUID())).rejects.toMatchObject({ code: "personal_project_archived" });
      await expect(cloud.rename(a("owner"), chat.id, "Renamed", chat.revision)).rejects.toMatchObject({ code: "personal_project_archived" });
      expect((await cloud.files.list(a("owner"), chat.id)).files).toEqual([]);
      await cloud.remove(a("owner"), chat.id, chat.revision);
      expect((await personal().detail(a("owner"), project.id)).conversationCount).toBe(0);
    });
  });

  describe("retention and removal", () => {
    it("keeps a deleted project's chats for the recovery window and purges everything afterward", async () => {
      const project = await make(a("owner"));
      const inProject = await openChat(a("owner"), project.id);
      const live = await make(a("owner"), "Live");
      const inLive = await openChat(a("owner"), live.id);
      const loose = await cloud.create(a("owner"), "Loose");
      const reference = await upload(a("owner"), project.id, "gone-soon.txt", "bytes");
      await migration.query("UPDATE cloud_work_settings SET retention_days=1");
      await personal().lifecycle(a("owner"), project.id, { requestId: randomUUID(), status: "deleted", expectedRevision: project.revision });
      await migration.query("UPDATE cloud_work_conversations SET updated_at=NOW()-INTERVAL '10 days'");
      await cloud.maintain();
      const remaining = (await migration.query("SELECT id FROM cloud_work_conversations")).rows.map((r) => r.id);
      expect(remaining).toEqual([inProject.id]);
      expect(remaining).not.toContain(inLive.id);
      expect(remaining).not.toContain(loose.id);
      await migration.query("UPDATE cloud_work_personal_projects SET purge_after=NOW()-INTERVAL '1 minute' WHERE id=$1", [project.id]);
      await cloud.maintain();
      expect((await migration.query("SELECT 1 FROM cloud_work_personal_projects WHERE id=$1", [project.id])).rowCount).toBe(0);
      expect((await migration.query("SELECT 1 FROM cloud_work_conversations WHERE id=$1", [inProject.id])).rowCount).toBe(0);
      expect((await migration.query("SELECT 1 FROM cloud_work_personal_project_references WHERE id=$1", [reference.id])).rowCount).toBe(0);
      expect((await migration.query("SELECT 1 FROM cloud_work_personal_blob_references")).rowCount).toBe(0);
    });
    it("trims idempotency records after a week", async () => {
      await make(a("owner"));
      await migration.query("UPDATE cloud_work_personal_project_requests SET created_at=NOW()-INTERVAL '8 days'");
      await cloud.maintain();
      expect((await migration.query("SELECT 1 FROM cloud_work_personal_project_requests")).rowCount).toBe(0);
    });
    it("permanently deletes personal projects, chats, references and requests when the member is removed", async () => {
      await policy({ allowAll: true });
      const project = await make(a("carol"), "Carol's folder");
      await openChat(a("carol"), project.id);
      await upload(a("carol"), project.id, "carol.txt", "carol");
      session = "owner";
      await identity.removeMember({}, "carol-member");
      for (const table of ["cloud_work_personal_projects", "cloud_work_personal_project_references", "cloud_work_personal_project_reference_versions", "cloud_work_personal_project_requests", "cloud_work_conversations"])
        expect((await migration.query(`SELECT 1 FROM ${table} WHERE member_id='carol-member'`)).rowCount).toBe(0);
      expect((await migration.query("SELECT 1 FROM cloud_work_personal_blob_references")).rowCount).toBe(0);
      await migration.query(`INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES('carol-member','org','carol','member',NOW())`);
    });
  });
});
