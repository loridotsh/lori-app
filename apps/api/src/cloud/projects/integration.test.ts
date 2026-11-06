import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../config.js";
import type { LoriAuth } from "../../auth/auth.js";
import { IdentityService } from "../../auth/identity-service.js";
import { EnrollmentService } from "../../auth/enrollment-service.js";
import { TeamService } from "../../auth/team-service.js";
import { WorkService, defaultWorkPolicy } from "../../auth/work-service.js";
import { ProviderGatewayService } from "../../auth/provider-gateway-service.js";
import { CloudWorkService, type CloudActor } from "../service.js";
import { ProjectKeyring, sealProjectValue } from "./crypto.js";
import { notifications } from "../notifications.js";
import { DEFAULT_PROJECT_POLICY } from "./policy.js";
import { rewrapProjectKeys } from "./key-rotation.js";
import { provisionRuntime } from "../../db/provision-runtime.js";

const integration = process.env.LORI_CLOUD_INTEGRATION_TEST === "1" ? describe : describe.skip;
integration("Projects with a non-owner, non-bypass PostgreSQL runtime", () => {
  const suffix = randomUUID().replaceAll("-", ""), schema = `projects_${suffix}`, role = `project_runtime_${suffix}`;
  let admin: Pool, migration: Pool, pool: Pool, cloud: CloudWorkService, directory: string, identity: IdentityService;
  const wrappingKey = randomBytes(32).toString("base64url");
  const selectedUser = "owner";
  let gatewayId: string;
  const a = (name: string, organizationId = "org"): CloudActor => ({ organizationId, memberId: `${name}-member`, userId: name, role: name.startsWith("owner") ? "admin" : "member", browserSessionId: `session-${name}` });
  const headers = { origin: "https://cloud.example.test" };
  beforeAll(async () => {
    directory = await mkdtemp(resolve(tmpdir(), "lori-project-test-"));
    const keys = resolve(directory, "keys.json");
    await writeFile(keys, JSON.stringify({ active: "one", keys: { one: wrappingKey } }), { mode: 0o600 });
    const config = loadConfig({ ...process.env, NODE_ENV: "test", LORI_ADDRESS: headers.origin, WORK_CLOUD_WORKER_SECRET: "test-project-worker-secret-never-a-real-secret", WORK_CLOUD_PROJECTS_ENABLED: "true", WORK_CLOUD_PROJECT_KEYS_FILE: keys });
    config.cloud!.filesDirectory = resolve(directory, "files");
    const db = { host: config.database.host, port: config.database.port, database: config.database.name, user: config.database.user, password: config.database.password };
    admin = new Pool(db);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    migration = new Pool({ ...db, options: `-c search_path=${schema},public` });
    for (const file of readdirSync(resolve(import.meta.dirname, "../../../migrations")).filter(f => /^\d+_.*\.sql$/.test(f)).sort())
      await migration.query(readFileSync(resolve(import.meta.dirname, "../../../migrations", file), "utf8"));
    const runtimePassword = randomBytes(32).toString("base64url");
    await provisionRuntime(migration, role, runtimePassword);
    pool = new Pool({ ...db, user: role, password: runtimePassword, options: `-c search_path=${schema},public`, max: 5 });
    await migration.query(`INSERT INTO organization(id,name,slug,"createdAt") VALUES('org','Organization','org',NOW()),('other','Other','other',NOW());
      INSERT INTO organization_policies(organization_id) VALUES('org'),('other');`);
    for (const name of ["owner", "owner2", "alice", "bob", "outside", "dashboard-viewer", "dashboard-manager", "dashboard-creator"]) {
      const org = name === "outside" ? "other" : "org";
      await migration.query('INSERT INTO "user"(id,name,email,"createdAt","updatedAt") VALUES($1,$1,$2,NOW(),NOW())', [name, `${name}@test.invalid`]);
      await migration.query('INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,$4,NOW())', [`${name}-member`, org, name, name.startsWith("owner") ? "admin" : "member"]);
      await migration.query('INSERT INTO session(id,token,"userId","createdAt","updatedAt","expiresAt") VALUES($1,$1,$2,NOW(),NOW(),NOW()+INTERVAL \'1 day\')', [`session-${name}`, name]);
    }
    for (const org of ["org", "other"]) await migration.query("INSERT INTO organization_work_policies(organization_id,policy) VALUES($1,$2)", [org, JSON.stringify({ ...defaultWorkPolicy(), enabled: true, memoryAllowed: true, managedCatalog: [{ type: "provider", id: "openai", enabled: true }], providerModels: [{ providerId: "openai", modelIds: ["test-model"] }] })]);
    const auth = { api: { getSession: async () => ({ session: { id: `session-${selectedUser}`, userId: selectedUser }, user: { id: selectedUser } }) } } as unknown as LoriAuth;
    identity = new IdentityService(pool, auth, config);
    const enrollment = new EnrollmentService(pool, auth, config);
    const teams = new TeamService(pool, auth, config, enrollment), work = new WorkService(pool, identity, teams, enrollment);
    const providers = new ProviderGatewayService(pool, auth, config, enrollment, work);
    cloud = new CloudWorkService(pool, config, identity, enrollment, work, providers);
    await providers.createWorkOrganizationGateway(headers, { providerId: "openai", apiKey: "synthetic-test-provider-secret", requestsPerMinute: 60, expectedRevision: 1 });
    gatewayId = (await migration.query("SELECT id FROM organization_provider_gateways WHERE organization_id='org'")).rows[0].id;
  }, 30000);
  afterAll(async () => {
    await cloud?.tools.close(); await cloud?.files.close(); await pool?.end(); await migration?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); if ((await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount) { await admin.query(`DROP OWNED BY "${role}"`); await admin.query(`DROP ROLE "${role}"`); } await admin.end(); }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const create = (name = "Client confidential") => cloud.projects.create(a("owner"), { requestId: randomUUID(), name, description: "Restricted case", instructions: "Use only this client's evidence." });
  const share = async (id: string, extra: { subjectId: string; role: "contributor" | "viewer" }[], blocks: string[] = []) => {
    const members = await cloud.projects.memberships(a("owner"), id);
    return cloud.projects.setMemberships(a("owner"), id, { expectedRevision: members.revision, grants: [{ kind: "member", subjectId: "owner-member", role: "manager", deniedActions: [] }, ...extra.map(g => ({ ...g, kind: "member" as const, deniedActions: [] }))], blocks });
  };
  it("delivers content-free attention only to the initiator and rechecks revoked project access", async () => {
    const p=await create("Private notification case");
    await share(p.id,[{subjectId:"alice-member",role:"contributor"}]);
    const conv=await cloud.create(a("owner"),"Never put this title on a lock screen",p.id);
    const sent=await cloud.submit(a("alice"),conv.id,{requestId:randomUUID(),text:"Secret question",gatewayId,modelId:"test-model",expectedRevision:conv.revision});
    await cloud.transaction(async c=>{ await cloud.ensure(c,a("alice")); await cloud.projects.authorize(c,a("alice"),p.id); await c.query("UPDATE cloud_work_runs SET status='completed' WHERE id=$1",[sent.run.id]); });
    const query={since:new Date(Date.now()-60_000).toISOString()};
    const result=await notifications(cloud,a("alice"),query);
    const event=result.events.find(e=>e.runId===sent.run.id);
    expect(event).toMatchObject({kind:"completed",conversationId:conv.id,projectId:p.id});
    expect(JSON.stringify(result)).not.toContain("Secret");
    expect(JSON.stringify(result)).not.toContain("lock screen");
    expect((await notifications(cloud,a("owner"),query)).events.some(e=>e.runId===sent.run.id)).toBe(false);
    expect((await notifications(cloud,a("outside","other"),query)).events).toEqual([]);
    expect((await pool.query("SELECT * FROM cloud_work_notifications")).rows).toEqual([]);
    await share(p.id,[],["alice-member"]);
    expect((await notifications(cloud,a("alice"),query)).events.some(e=>e.runId===sent.run.id)).toBe(false);
  });
  it("records private maintenance failures without changing caller organization scope or duplicating events", async () => {
    const conv=await cloud.create(a("alice"),"Private");
    const sent=await cloud.submit(a("alice"),conv.id,{requestId:randomUUID(),text:"Private prompt",gatewayId,modelId:"test-model",expectedRevision:conv.revision});
    await cloud.transaction(async c=>{
      await c.query("UPDATE cloud_work_runs SET status='failed' WHERE id=$1",[sent.run.id]);
      expect((await c.query("SELECT current_setting('lori.organization_id',true) AS scope")).rows[0].scope || "").toBe("");
      await c.query("UPDATE cloud_work_runs SET status='failed' WHERE id=$1",[sent.run.id]);
    });
    const result=await notifications(cloud,a("alice"),{since:new Date(Date.now()-60_000).toISOString()});
    expect(result.events.filter(e=>e.runId===sent.run.id)).toHaveLength(1);
    expect(result.events.find(e=>e.runId===sent.run.id)?.kind).toBe("failed");
  });
  it("drops resolved and rolled-back approval notifications", async () => {
    const conv=await cloud.create(a("alice"),"Approval test");
    const sent=await cloud.submit(a("alice"),conv.id,{requestId:randomUUID(),text:"Test",gatewayId,modelId:"test-model",expectedRevision:conv.revision});
    const round=randomUUID(), approval=randomUUID();
    await cloud.transaction(async c=>{
      await cloud.ensure(c,a("alice"));
      await c.query("UPDATE cloud_work_runs SET status='awaitingApproval' WHERE id=$1",[sent.run.id]);
      await c.query("INSERT INTO cloud_work_rounds(id,run_id,round_index,request_fingerprint) VALUES($1,$2,0,'test')",[round,sent.run.id]);
      const invocation=randomUUID();
      await c.query("INSERT INTO cloud_work_tool_invocations(id,run_id,round_id,call_id,request_id,name,arguments,action_hash,status) VALUES($1,$2,$3,'call',$4,'command','{}','hash','pendingApproval')",[invocation,sent.run.id,round,randomUUID()]);
      await c.query("INSERT INTO cloud_work_approvals(id,run_id,invocation_id,action_hash) VALUES($1,$2,$3,'hash')",[approval,sent.run.id,invocation]);
    });
    const query={since:new Date(Date.now()-60_000).toISOString()};
    expect((await notifications(cloud,a("alice"),query)).events.filter(e=>e.runId===sent.run.id)).toMatchObject([{kind:"approval",approvalId:approval}]);
    await cloud.transaction(async c=>{await cloud.ensure(c,a("alice"));await c.query("UPDATE cloud_work_approvals SET status='denied' WHERE id=$1",[approval]);});
    expect((await notifications(cloud,a("alice"),query)).events.filter(e=>e.runId===sent.run.id)).toEqual([]);
    await expect(cloud.transaction(async c=>{await cloud.ensure(c,a("alice"));await c.query("UPDATE cloud_work_runs SET status='failed' WHERE id=$1",[sent.run.id]);throw new Error("rollback");})).rejects.toThrow("rollback");
    expect((await notifications(cloud,a("alice"),query)).events.filter(e=>e.runId===sent.run.id)).toEqual([]);
  });
  it("hides content from unassigned members and gives organization admins full shared-project access", async () => {
    const project = await create();
    await expect(cloud.projects.detail(a("bob"), project.id)).rejects.toMatchObject({ statusCode: 404 });
    // Another administrator needs no grant and no temporary access request.
    const adminView = await cloud.projects.detail(a("owner2"), project.id);
    expect(adminView.access).toMatchObject({ role: "manager", source: "organization_admin", audited: false });
    expect(adminView.access.actions).toEqual(expect.arrayContaining(["read", "chat", "files.write", "members.manage", "connections.manage", "instructions.write"]));
    expect(adminView.instructions).toBe("Use only this client's evidence.");
    expect((await cloud.projects.list(a("owner2"))).projects.some(p => p.id === project.id)).toBe(true);
    expect((await cloud.projects.list(a("bob"))).projects.some(p => p.id === project.id)).toBe(false);
    expect((await cloud.projects.list(a("owner2"), true)).projects.some(p => p.id === project.id)).toBe(true);
    const governance = await cloud.projects.governance(a("owner2"), project.id);
    expect(governance).not.toHaveProperty("instructions");
    expect(governance).not.toHaveProperty("content");
    const connectionInventory = await cloud.extensions.snapshot({ ...a("owner2"), projectId: project.id, projectManagement: true });
    expect(connectionInventory).not.toHaveProperty("instructions");
    await expect(cloud.extensions.snapshot({ ...a("bob"), projectId: project.id, projectManagement: true })).rejects.toMatchObject({ statusCode: 404 });
    await expect(cloud.projects.governance(a("bob"), project.id)).rejects.toMatchObject({ statusCode: 403 });
    expect((await cloud.projects.permissionPreview(a("owner2"), project.id, "bob-member")).access.actions).toEqual([]);
    const adminPreview = await cloud.projects.permissionPreview(a("owner"), project.id, "owner2-member");
    expect(adminPreview).toMatchObject({ administrator: true, access: { source: "organization_admin" } });
    const conversation = await cloud.create(a("owner2"), "Admin thread", project.id);
    expect(conversation.projectId).toBe(project.id);
    // A member-level block does not silently reduce an administrator's role.
    const members = await cloud.projects.memberships(a("owner"), project.id);
    await cloud.projects.setMemberships(a("owner"), project.id, { expectedRevision: members.revision, grants: members.grants.map(({ id: _id, ...grant }) => grant), blocks: ["owner2-member"] });
    expect((await cloud.projects.detail(a("owner2"), project.id)).access.actions).toContain("chat");
    await expect(cloud.projects.detail(a("outside", "other"), project.id)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("makes project-assigned models usable inside the project only", async () => {
    // Bob has no general Work model: his member override removes the organization default.
    await migration.query("INSERT INTO member_work_policy_overrides(member_id,overrides) VALUES('bob-member',$1) ON CONFLICT (member_id) DO UPDATE SET overrides=EXCLUDED.overrides", [JSON.stringify({ enabled: null, personalInstallations: { plugins: null, providers: null, skills: null }, managedCatalog: [], providerModels: [] })]);
    await migration.query("UPDATE organization_work_policies SET policy=$2, delegation=$3 WHERE organization_id=$1", ["org", JSON.stringify({ ...defaultWorkPolicy(), enabled: true, managedCatalog: [{ type: "provider", id: "openai", enabled: true }], providerModels: [] }), JSON.stringify({ version: 1, enabled: true, personalInstallations: { plugins: false, providers: false, skills: false }, managedCatalog: [{ type: "provider", id: "openai" }], providerModels: [{ providerId: "openai", modelIds: ["test-model"] }] })]);
    try {
      const project = await create("Assigned models");
      await share(project.id, [{ subjectId: "bob-member", role: "contributor" }]);
      const detail = await cloud.projects.detail(a("owner"), project.id);
      // A nonempty list without modes is refused: its meaning changed.
      await expect(cloud.projects.update(a("owner"), project.id, { expectedRevision: detail.revision, policy: { ...detail.policy, providerMode: undefined, providerModels: [{ providerId: "openai", modelIds: ["test-model"] }] } })).rejects.toMatchObject({ code: "project_policy_upgrade_required" });
      await expect(cloud.projects.update(a("owner"), project.id, { expectedRevision: detail.revision, policy: { ...detail.policy, providerMode: "assigned", providerModels: [{ providerId: "openai", modelIds: ["unapproved-model"] }] } })).rejects.toMatchObject({ code: "project_resource_not_approved" });
      await cloud.projects.update(a("owner"), project.id, { expectedRevision: detail.revision, policy: { ...detail.policy, providerMode: "assigned", providerModels: [{ providerId: "openai", modelIds: ["test-model"] }] } });
      const inProject = await cloud.capabilities({ ...a("bob"), selectedProjectId: project.id });
      expect(inProject.providers.map(p => p.modelIds)).toEqual([["test-model"]]);
      expect((await cloud.capabilities(a("bob"))).providers).toEqual([]);
      const conv = await cloud.create(a("bob"), "Project question", project.id);
      const sent = await cloud.submit(a("bob"), conv.id, { requestId: randomUUID(), text: "Use the project model", gatewayId, modelId: "test-model", expectedRevision: conv.revision });
      expect(sent.run.status).toBe("queued");
      const privateConv = await cloud.create(a("bob"), "Private question");
      await expect(cloud.submit(a("bob"), privateConv.id, { requestId: randomUUID(), text: "Outside the project", gatewayId, modelId: "test-model", expectedRevision: privateConv.revision })).rejects.toMatchObject({ statusCode: 403 });
      const preview = await cloud.projects.permissionPreview(a("owner"), project.id, "bob-member");
      expect(preview.resources?.models).toEqual([expect.objectContaining({ providerId: "openai", id: "test-model", allowed: true, source: "project_assignment" })]);
      await cloud.transaction(async c => { await cloud.ensure(c, a("bob")); await cloud.projects.authorize(c, a("bob"), project.id); await c.query("UPDATE cloud_work_runs SET status='completed' WHERE id=$1", [sent.run.id]); });
    } finally {
      await migration.query("DELETE FROM member_work_policy_overrides WHERE member_id='bob-member'");
      await migration.query("UPDATE organization_work_policies SET policy=$2, delegation=NULL WHERE organization_id=$1", ["org", JSON.stringify({ ...defaultWorkPolicy(), enabled: true, memoryAllowed: true, managedCatalog: [{ type: "provider", id: "openai", enabled: true }], providerModels: [{ providerId: "openai", modelIds: ["test-model"] }] })]);
    }
  });
  it("shares conversations and files while keeping storage encrypted and RLS closed", async () => {
    const p = await create("Secret case Athena"); await share(p.id, [{ subjectId: "alice-member", role: "contributor" }, { subjectId: "bob-member", role: "viewer" }]);
    const conv = await cloud.create(a("alice"), "Sensitive conversation Athena", p.id);
    const file = await cloud.files.upload(a("alice"), conv.id, "Athena-confidential.txt", "text/plain", Buffer.from("Athena sensitive contents"), randomUUID());
    const second = await cloud.create(a("owner"), "Second discussion", p.id);
    expect((await cloud.files.list(a("owner"), second.id)).files[0]?.id).toBe(file.id);
    expect((await cloud.files.text(a("bob"), file.id)).text).toContain("Athena sensitive contents");
    await expect(cloud.files.download(a("bob"), file.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await cloud.list(a("alice"), 50)).conversations.some(c => c.id === conv.id)).toBe(false);
    expect((await cloud.list(a("bob"), 50, undefined, p.id)).conversations).toHaveLength(2);
    expect((await pool.query("SELECT * FROM cloud_work_conversations WHERE project_id=$1", [p.id])).rowCount).toBe(0);
    const stored = (await migration.query("SELECT title FROM cloud_work_conversations WHERE id=$1", [conv.id])).rows[0].title;
    expect(stored).not.toContain("Sensitive conversation Athena");
    for (const blob of await readdir(resolve(directory, "files"))) expect((await readFile(resolve(directory, "files", blob))).toString()).not.toContain("Athena sensitive contents");
    const other = await create("Other client"); const otherChat = await cloud.create(a("owner"), "Other", other.id);
    await expect(cloud.transaction(async c => { await cloud.ensure(c, a("owner")); await cloud.ownConversation(c, a("owner"), otherChat.id); return cloud.files.attached(c, a("owner"), otherChat.id, [file.id]); })).rejects.toMatchObject({ statusCode: 404 });
  });
  it("executes under the turn initiator and rejects revoked worker authority", async () => {
    const p = await create(); await share(p.id, [{ subjectId: "alice-member", role: "contributor" }]);
    const conv = await cloud.create(a("owner"), "Shared thread", p.id);
    const sent = await cloud.submit(a("alice"), conv.id, { requestId: randomUUID(), text: "Project-only sensitive question", gatewayId, modelId: "test-model", expectedRevision: conv.revision });
    expect(sent.run.initiatedBy).toBe("alice-member");
    expect((await cloud.list(a("owner"), 30, undefined, p.id)).conversations.find(item => item.id === conv.id)?.latestRunStatus).toBe("queued");
    await expect(cloud.list(a("outside", "other"), 30, undefined, p.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await cloud.claim("old-worker", { tools: true })).toBeNull();
    const claimed = await cloud.claim("project-worker", { tools: true, projectScopes: true }); expect(claimed).not.toBeNull();
    const claims = cloud.claims(`Bearer ${claimed!.leaseToken}`, sent.run.id);
    expect((await cloud.list(a("alice"), 30, undefined, p.id)).conversations.find(item => item.id === conv.id)?.latestRunStatus).toBe("running");
    expect(claims.projectId).toBe(p.id);
    const round = await cloud.rounds.begin(claims, randomUUID(), 0, { model: "test-model", stream: true });
    expect(round.usageContext.projectId).toBe(p.id);
    await cloud.rounds.reportUsage(round.usageContext, { inputTokens: 42 });
    await cloud.rounds.reportUsage(round.usageContext, { outputTokens: 7 });
    const usage = (await migration.query("SELECT usage,usage_sequence FROM cloud_work_rounds WHERE id=$1", [round.usageContext.roundId])).rows[0];
    expect(usage.usage).toMatchObject({ inputTokens: 42, outputTokens: 7 });
    expect(Number(usage.usage_sequence)).toBe(2);
    await cloud.delta(claims, randomUUID(), "Encrypted project answer");
    expect((await cloud.snapshot(a("owner"), sent.run.id)).assistantText).toBe("Encrypted project answer");
    await share(p.id, [{ subjectId: "alice-member", role: "contributor" }], ["alice-member"]);
    await expect(cloud.heartbeat(claims)).rejects.toMatchObject({ statusCode: 404 });
    await expect(cloud.snapshot(a("alice"), sent.run.id)).rejects.toMatchObject({ statusCode: 404 });
    await cloud.cancel(a("owner"), sent.run.id);
  });
  it("keeps project memory separate from personal memory and other projects", async () => {
    const p = await create(), other = await create();
    await cloud.transaction(async c => { await cloud.ensure(c, a("owner")); await cloud.projectMemory.saveTx(c, a("owner"), p.id, randomUUID(), { topic: "Case decision", content: "The project reference is AMBER-ONLY." }); });
    const chat = await cloud.create(a("owner"), "Memory", p.id);
    const context = await cloud.transaction(async c => { await cloud.ensure(c, a("owner")); await cloud.ownConversation(c, a("owner"), chat.id); return cloud.memory.contextTx(c, a("owner"), chat.id); });
    expect(context).toContain("AMBER-ONLY");
    expect((await cloud.memory.list(a("owner"), {})).notes).toEqual([]);
    await cloud.projectRetrieval.rebuild("org", p.id);
    const results = await cloud.transaction(async c => { await cloud.ensure(c, a("owner")); return cloud.projectRetrieval.searchTx(c, a("owner"), p.id, "AMBER"); });
    expect(results.sources.some(s => s.excerpt.includes("AMBER-ONLY"))).toBe(true);
    const otherNotes = await cloud.transaction(async c => { await cloud.ensure(c, a("owner")); return cloud.projectMemory.listTx(c, a("owner"), other.id); });
    expect(otherNotes).toEqual([]);
  });
  it("ranks memory by meaning inside each authorized scope and withdraws stale vectors", async () => {
    if (!cloud.semantic.available) return;
    const paraphrase = "कुत्ते को दवा कितनी बार देनी है?";
    const mine = await cloud.memory.create(a("alice"), { requestId: randomUUID(), scope: "personal", topic: "pet", content: "My dog Bruno needs his medicine twice a day." });
    const theirs = await cloud.memory.create(a("bob"), { requestId: randomUUID(), scope: "personal", topic: "pet", content: "My dog Rex needs his medicine twice a day." });
    const chat = await cloud.create(a("alice"), "Filed chat");
    const scoped = await cloud.memory.create(a("alice"), { requestId: randomUUID(), scope: "conversation", conversationId: chat.id, topic: "vet", content: "The vet said the puppy takes tablets every morning." });
    await cloud.memory.indexPending(64);
    expect((await migration.query("SELECT count(*)::int AS n FROM cloud_work_memory_vectors WHERE note_id=ANY($1::uuid[])", [[mine.id, theirs.id, scoped.id]])).rows[0].n).toBeGreaterThanOrEqual(3);
    expect((await cloud.memory.list(a("alice"), { q: paraphrase }, true)).notes).toEqual([]);
    expect(await cloud.semantic.query(paraphrase)).not.toBeNull();
    const found = (await cloud.memory.list(a("alice"), { q: paraphrase }, true)).notes.map(n => n.id);
    expect(found).toContain(mine.id);
    expect(found).not.toContain(theirs.id);
    const only = await cloud.transaction(async c => { await cloud.ensure(c, a("alice")); return cloud.memory.searchTx(c, a("alice"), { q: paraphrase, conversationId: chat.id, conversationOnly: true }, true); });
    expect(only.map(n => n.id)).not.toContain(mine.id);
    const context = await cloud.transaction(async c => { await cloud.ensure(c, a("alice")); return cloud.memory.contextTx(c, a("alice"), chat.id, false, paraphrase); });
    expect(context.indexOf("Bruno")).toBeGreaterThanOrEqual(0);
    expect(context).not.toContain("Rex");
    await cloud.memory.edit(a("alice"), mine.id, { requestId: randomUUID(), expectedRevision: mine.revision, topic: "car", content: "I park in the north garage." });
    expect((await migration.query("SELECT count(*)::int AS n FROM cloud_work_memory_vectors WHERE note_id=$1", [mine.id])).rows[0].n).toBe(0);
    expect((await cloud.memory.list(a("alice"), { q: paraphrase }, true)).notes.map(n => n.id)).not.toContain(mine.id);
    await cloud.memory.remove(a("bob"), theirs.id, theirs.revision);
    expect((await migration.query("SELECT count(*)::int AS n FROM cloud_work_memory_vectors WHERE note_id=$1", [theirs.id])).rows[0].n).toBe(0);
    const p = await create("Semantic project");
    await cloud.transaction(async c => { await cloud.ensure(c, a("owner")); await cloud.projectMemory.saveTx(c, a("owner"), p.id, randomUUID(), { topic: "pet", content: "My dog Saffron needs his medicine twice a day." }); });
    await cloud.projectRetrieval.rebuild("org", p.id);
    const stored = (await migration.query("SELECT vectors::text AS v,semantic_revision,revision FROM cloud_work_project_search WHERE project_id=$1", [p.id])).rows[0];
    expect(stored.v).toContain('"$project": 1');
    expect(stored.v).not.toContain("Saffron");
    expect(Number(stored.semantic_revision)).toBe(Number(stored.revision));
    const question = paraphrase;
    const lexicalOnly = await cloud.transaction(async c => { await cloud.ensure(c, a("owner")); return cloud.projectRetrieval.searchTx(c, a("owner"), p.id, question); });
    expect(lexicalOnly.sources.some(s => s.excerpt.includes("Saffron"))).toBe(cloud.semantic.peek(question) !== null);
    await cloud.semantic.query(question);
    const recall = await cloud.transaction(async c => { await cloud.ensure(c, a("owner")); return cloud.projectRetrieval.searchTx(c, a("owner"), p.id, question); });
    expect(recall.sources.some(s => s.excerpt.includes("Saffron"))).toBe(true);
    const otherProject = await create("Unrelated project");
    await cloud.projectRetrieval.rebuild("org", otherProject.id);
    const leaked = await cloud.transaction(async c => { await cloud.ensure(c, a("owner")); return cloud.projectRetrieval.searchTx(c, a("owner"), otherProject.id, question); });
    expect(leaked.sources).toEqual([]);
  }, 120_000);
  it("gates desktop project rollout without disabling browser project access", async () => {
    const p = await create();
    expect((await cloud.projects.capabilities(a("owner"))).desktopAvailable).toBe(false);
    await expect(cloud.projects.list({ ...a("owner"), deviceId: "synthetic-device" })).rejects.toMatchObject({ code: "projects_unavailable" });
    expect((await cloud.projects.detail(a("owner"), p.id)).id).toBe(p.id);
    cloud.config.cloud!.desktopProjectsEnabled = true;
    try { expect((await cloud.projects.capabilities(a("owner"))).desktopAvailable).toBe(true); }
    finally { cloud.config.cloud!.desktopProjectsEnabled = false; }
  });
  it("rejects plaintext storage and immutable scope changes at the database boundary", async () => {
    const p = await create();
    const chat = await cloud.create(a("owner"), "Protected", p.id);
    await expect(migration.query("UPDATE cloud_work_projects SET content='{}'::jsonb WHERE id=$1", [p.id])).rejects.toMatchObject({ code: "23514" });
    const sent = await cloud.submit(a("owner"), chat.id, { requestId: randomUUID(), text: "Encrypted", gatewayId, modelId: "test-model", expectedRevision: chat.revision });
    await expect(migration.query("UPDATE cloud_work_messages SET text='plaintext secret' WHERE run_id=$1", [sent.run.id])).rejects.toMatchObject({ code: "23514" });
    await expect(migration.query("UPDATE cloud_work_conversations SET project_id=NULL,member_id='owner-member' WHERE id=$1", [chat.id])).rejects.toMatchObject({ code: "23514" });
    expect((await cloud.detail(a("owner"), chat.id)).conversation.title).toBe("Protected");
    await cloud.cancel(a("owner"), sent.run.id);
  });
  it("fails closed when the mounted keyring no longer matches storage", async () => {
    await create();
    const original = (await migration.query("SELECT wrapped_key FROM cloud_work_project_key_check WHERE singleton")).rows[0].wrapped_key;
    await migration.query("UPDATE cloud_work_project_key_check SET wrapped_key=$1", [JSON.stringify({ ...original, tag: randomBytes(16).toString("base64url") })]);
    try {
      expect((await cloud.projects.capabilities(a("owner"))).available).toBe(false);
      await expect(create()).rejects.toMatchObject({ statusCode: 503 });
      expect((await cloud.list(a("owner"), 10)).conversations).toEqual([]);
    } finally { await migration.query("UPDATE cloud_work_project_key_check SET wrapped_key=$1", [JSON.stringify(original)]); }
  });
  it("keeps tool receipts encrypted and attributes a manager's exact-action approval", async () => {
    const p = await create(); await share(p.id, [{ subjectId: "alice-member", role: "contributor" }]);
    const chat = await cloud.create(a("owner"), "Approval review", p.id);
    const sent = await cloud.submit(a("alice"), chat.id, { requestId: randomUUID(), text: "Write a project note", gatewayId, modelId: "test-model", expectedRevision: chat.revision });
    const claimed = await cloud.claim("approval-worker", { tools: true, files: true, projectScopes: true });
    const claims = cloud.claims(`Bearer ${claimed!.leaseToken}`, sent.run.id);
    const roundId = randomUUID(), call = { id: "call-project", name: "write_file", arguments: { path: "approved.txt", content: "SECRET-PROJECT-TOOL-CONTENT" } };
    await cloud.rounds.begin(claims, roundId, 0, { model: "test-model", stream: true });
    await cloud.rounds.receipt(claims, roundId, { roundIndex: 0, assistant: { role: "assistant", text: "", native: { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }, toolCalls: [call] });
    const requested = await cloud.tools.request(claims, { requestId: randomUUID(), roundId, call });
    expect(requested.status).toBe("pendingApproval");
    const approval = (await cloud.snapshot(a("owner"), sent.run.id)).approvals![0]!;
    await cloud.tools.decide(a("owner"), sent.run.id, approval.id, { requestId: randomUUID(), actionHash: approval.actionHash, decision: "approve" });
    const file = (await cloud.files.list(a("alice"), chat.id)).files[0]!;
    expect((await cloud.files.text(a("alice"), file.id)).text).toBe("SECRET-PROJECT-TOOL-CONTENT");
    expect((await migration.query("SELECT decided_by FROM cloud_work_approvals WHERE id=$1", [approval.id])).rows[0].decided_by).toBe("owner-member");
    for (const table of ["cloud_work_rounds", "cloud_work_tool_invocations", "cloud_work_events"]) {
      expect(JSON.stringify((await migration.query(`SELECT * FROM ${table} WHERE run_id=$1`, [sent.run.id])).rows)).not.toContain("SECRET-PROJECT-TOOL-CONTENT");
    }
    await cloud.cancel(a("owner"), sent.run.id);
  });
  it("keeps project todo content encrypted and recovers only the owning conversation's plan", async () => {
    const p=await create();
    const chat=await cloud.create(a("owner"),"Todo privacy",p.id);
    const sent=await cloud.submit(a("owner"),chat.id,{requestId:randomUUID(),text:"Review sources",gatewayId,modelId:"test-model",expectedRevision:chat.revision});
    const claimed=(await cloud.claim("todo-project-worker",{tools:true,projectScopes:true}))!;
    const claims=cloud.claims(`Bearer ${claimed.leaseToken}`,sent.run.id);
    const roundId=randomUUID();
    const call={id:"project-todo",name:"write_todos",arguments:{expectedRevision:0,todos:[{id:"review",content:"SECRET-PROJECT-TODO-CONTENT",status:"in_progress"}]}};
    await cloud.rounds.begin(claims,roundId,0,{});
    await cloud.rounds.receipt(claims,roundId,{roundIndex:0,assistant:{role:"assistant",text:"",native:{role:"assistant",content:null,tool_calls:[{id:call.id,type:"function",function:{name:call.name,arguments:JSON.stringify(call.arguments)}}]}},toolCalls:[call]});
    expect((await cloud.tools.request(claims,{requestId:randomUUID(),roundId,call})).status).toBe("completed");
    const detail=await cloud.detail(a("owner"),chat.id);
    expect(detail.toolInvocations?.[0]?.output).toMatchObject({todoList:{revision:1,todos:call.arguments.todos}});
    expect((await cloud.snapshot(a("owner"),sent.run.id)).approvals).toEqual([]);
    const next=await cloud.rounds.begin(claims,randomUUID(),1,{});
    expect(JSON.stringify(next.body.messages)).toContain("SECRET-PROJECT-TODO-CONTENT");
    await expect(cloud.detail(a("bob"),chat.id)).rejects.toMatchObject({statusCode:404});
    expect(JSON.stringify((await migration.query("SELECT * FROM cloud_work_tool_invocations WHERE run_id=$1",[sent.run.id])).rows)).not.toContain("SECRET-PROJECT-TODO-CONTENT");
    await cloud.cancel(a("owner"),sent.run.id);
  });
  it("rewraps stored project keys and the readiness probe without changing content", async () => {
    const p = await create();
    const chat = await cloud.create(a("owner"), "Rotation survives", p.id);
    const old = new ProjectKeyring({ active: "one", keys: { one: wrappingKey } });
    const next = randomBytes(32).toString("base64url");
    const rotated = new ProjectKeyring({ active: "two", keys: { one: wrappingKey, two: next } });
    const restore = new ProjectKeyring({ active: "one", keys: { one: wrappingKey, two: next } });
    try {
      expect(await rewrapProjectKeys(migration, rotated)).toBeGreaterThan(0);
      const row = (await migration.query("SELECT wrapped_key FROM cloud_work_projects WHERE id=$1", [p.id])).rows[0];
      expect(row.wrapped_key.key).toBe("two");
      expect(() => old.unwrap("org", p.id, row.wrapped_key)).toThrow();
      rotated.unwrap("org", p.id, row.wrapped_key).key.fill(0);
      expect((await cloud.projects.capabilities(a("owner"))).available).toBe(false);
    } finally { await rewrapProjectKeys(migration, restore); }
    expect((await cloud.detail(a("owner"), chat.id)).conversation.title).toBe("Rotation survives");
  });
  it("enforces delegated management, team restrictions, and explicit blocks", async () => {
    const p = await create(), team = randomUUID();
    await migration.query("INSERT INTO team(id,organization_id,name,slug) VALUES($1,'org','Client team',$2)", [team, `team-${team}`]);
    await migration.query("INSERT INTO team_member(id,team_id,member_id,role) VALUES($1,$2,'bob-member','team_admin')", [randomUUID(), team]);
    expect((await cloud.projects.capabilities(a("bob"))).canManageProjects).toBe(false);
    await expect(cloud.projects.directory(a("bob"), p.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(cloud.projects.detail(a("bob"), p.id)).rejects.toMatchObject({ statusCode: 404 });
    await cloud.projects.update(a("owner"), p.id, { expectedRevision: p.revision, policy: { ...(await cloud.projects.governance(a("owner"), p.id)).policy, managersManageMembers: true, managersManageConnections: true } });
    let membership = await cloud.projects.memberships(a("owner"), p.id);
    const grants = [
      { kind: "member" as const, subjectId: "owner-member", role: "manager" as const, deniedActions: [] },
      { kind: "team" as const, subjectId: team, role: "manager" as const, deniedActions: [] },
      { kind: "member" as const, subjectId: "bob-member", role: "viewer" as const, deniedActions: ["export" as const] },
    ];
    await cloud.projects.setMemberships(a("owner"), p.id, { expectedRevision: membership.revision, grants, blocks: [] });
    expect((await cloud.projects.capabilities(a("bob"))).canManageProjects).toBe(true);
    const preview = await cloud.projects.permissionPreview(a("owner"), p.id, "bob-member");
    expect(preview.access.actions).toContain("members.manage"); expect(preview.access.actions).not.toContain("export");
    const projectDirectory = await cloud.projects.directory(a("bob"), p.id);
    expect(projectDirectory.members.some(member => member.id === "owner-member")).toBe(true);
    expect(projectDirectory.members.some(member => member.id === "outside-member")).toBe(false);
    expect(projectDirectory.teams.some(entry => entry.id === team)).toBe(true);
    membership = await cloud.projects.memberships(a("bob"), p.id);
    await expect(cloud.projects.setMemberships(a("bob"), p.id, { expectedRevision: membership.revision, grants: grants.map(g => ({ ...g, deniedActions: [] })), blocks: [] })).rejects.toMatchObject({ statusCode: 403 });
    await expect(cloud.projects.update(a("bob"), p.id, { expectedRevision: (await cloud.projects.detail(a("bob"), p.id)).revision, policy: (await cloud.projects.governance(a("owner"), p.id)).policy })).rejects.toMatchObject({ statusCode: 403 });
    await cloud.projects.setMemberships(a("owner"), p.id, { expectedRevision: membership.revision, grants, blocks: ["bob-member"] });
    const audit = (await migration.query("SELECT metadata FROM audit_events WHERE subject_id=$1 AND action='work.project.members.updated'", [p.id])).rows;
    expect(audit.some(row => row.metadata.blockedAdded?.includes("bob-member"))).toBe(true);
    expect(audit.some(row => row.metadata.grantChanges?.some((change: { subject: string }) => change.subject === `team:${team}`))).toBe(true);
    expect((await cloud.projects.capabilities(a("bob"))).canManageProjects).toBe(false);
    await expect(cloud.extensions.snapshot({ ...a("bob"), projectId: p.id, projectManagement: true })).rejects.toMatchObject({ statusCode: 404 });
    await expect(cloud.projects.memberships(a("bob"), p.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(cloud.projects.directory(a("bob"), p.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(cloud.projects.detail(a("bob"), p.id)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("keeps the management inventory separate from member chat while admins hold project access", async () => {
    const p = await create("Administrative inventory");
    await share(p.id, [{ subjectId: "dashboard-viewer-member", role: "viewer" }]);
    const inventory = await cloud.projects.managementList(a("owner2"), { projectId: p.id });
    expect(inventory.canAdminister).toBe(true);
    expect(inventory.projects).toHaveLength(1);
    expect(inventory.projects[0]!.access.source).toBe("organization_admin");
    expect(inventory.projects[0]!.access.actions).toContain("members.manage");
    expect(inventory.projects[0]!.assignments?.directMemberCount).toBe(2);
    expect(inventory.projects[0]).not.toHaveProperty("instructions");
    expect(inventory.projects[0]).not.toHaveProperty("policy");
    expect((await cloud.projects.detail(a("owner2"), p.id)).access.source).toBe("organization_admin");
    await expect(cloud.projects.managementList(a("dashboard-viewer"))).rejects.toMatchObject({ statusCode: 403 });
    await expect(cloud.projects.managementList({ ...a("dashboard-viewer"), role: "admin" })).rejects.toMatchObject({ statusCode: 403 });
    expect((await cloud.projects.list(a("dashboard-viewer"))).projects.map(value => value.id)).toEqual([p.id]);
    expect((await cloud.projects.detail(a("dashboard-viewer"), p.id)).instructions).toBe("Use only this client's evidence.");
  });
  it("limits delegated managers to their projects and explicitly delegated membership data", async () => {
    const p = await create("Delegated dashboard"), hidden = await create("Unassigned project");
    const membership = await cloud.projects.memberships(a("owner"), p.id);
    await cloud.projects.setMemberships(a("owner"), p.id, { expectedRevision: membership.revision, grants: [...membership.grants.map(({ id: _id, ...grant }) => grant), { kind: "member", subjectId: "dashboard-manager-member", role: "manager", deniedActions: [] }], blocks: [] });
    let page = await cloud.projects.managementList(a("dashboard-manager"));
    expect(page.canAdminister).toBe(false); expect(page.total).toBeUndefined();
    expect(page.projects.map(value => value.id)).toEqual([p.id]);
    expect(page.projects[0]).not.toHaveProperty("assignments");
    expect((await cloud.projects.managementList(a("dashboard-manager"), { projectId: hidden.id })).projects).toEqual([]);
    expect((await cloud.projects.managementList(a("dashboard-manager"), { memberId: "owner-member" })).projects).toEqual([]);
    const current = await cloud.projects.detail(a("owner"), p.id);
    await cloud.projects.update(a("owner"), p.id, { expectedRevision: current.revision, policy: { ...current.policy, managersManageMembers: true } });
    page = await cloud.projects.managementList(a("dashboard-manager"), { projectId: p.id });
    expect(page.projects[0]!.assignments?.directMemberCount).toBe(2);
    const access = await cloud.projects.memberships(a("owner"), p.id);
    await cloud.projects.setMemberships(a("owner"), p.id, { expectedRevision: access.revision, grants: access.grants.map(({ id: _id, ...grant }) => grant), blocks: ["dashboard-manager-member"] });
    await expect(cloud.projects.managementList(a("dashboard-manager"))).rejects.toMatchObject({ statusCode: 403 });
  });
  it("separates team administration and delegated creation from project-manager authority", async () => {
    const team = randomUUID(), p = await create("Team-controlled assignment");
    await migration.query("INSERT INTO team(id,organization_id,name,slug) VALUES($1,'org','Dashboard team',$2)", [team, `team-${team}`]);
    await migration.query("INSERT INTO team_member(id,team_id,member_id,role) VALUES($1,$2,'dashboard-viewer-member','team_admin')", [randomUUID(), team]);
    const membership = await cloud.projects.memberships(a("owner"), p.id);
    await cloud.projects.setMemberships(a("owner"), p.id, { expectedRevision: membership.revision, grants: [...membership.grants.map(({ id: _id, ...grant }) => grant), { kind: "team", subjectId: team, role: "contributor", deniedActions: [] }], blocks: [] });
    await expect(cloud.projects.managementList(a("dashboard-viewer"))).rejects.toMatchObject({ statusCode: 403 });
    expect((await cloud.projects.managementList(a("owner"), { teamId: team })).projects.map(value => value.id)).toEqual([p.id]);
    const creation = await cloud.projects.creationPolicy(a("owner"));
    await cloud.projects.creationPolicy(a("owner"), { expectedRevision: creation.revision, grants: [{ kind: "member", subjectId: "dashboard-creator-member" }] });
    expect((await cloud.projects.managementList(a("dashboard-creator"))).canCreate).toBe(true);
    const created = await cloud.projects.create(a("dashboard-creator"), { requestId: randomUUID(), name: "Created in Manage", description: "Existing creation service", instructions: "" });
    expect((await cloud.projects.managementList(a("dashboard-creator"))).projects.map(value => value.id)).toEqual([created.id]);
    const next = await cloud.projects.creationPolicy(a("owner"));
    await cloud.projects.creationPolicy(a("owner"), { expectedRevision: next.revision, grants: [] });
    expect((await cloud.projects.managementList(a("dashboard-creator"))).canCreate).toBe(false);
  });
  it("paginates and searches 1,000 encrypted projects without returning content", async () => {
    const keys = new ProjectKeyring({ active: "one", keys: { one: wrappingKey } });
    const rows = Array.from({ length: 1000 }, (_, index) => {
      const id = randomUUID(), { context, wrapped } = keys.create("org", id);
      const content = sealProjectValue(context, "project", id, "content", { name: index === 999 ? "Management needle" : `Administrative project ${index}`, description: "Synthetic inventory fixture", instructions: "Private project instruction" });
      context.key.fill(0); return { id, content, wrapped_key: wrapped, grant_id: randomUUID() };
    });
    await migration.query("INSERT INTO cloud_work_projects(id,organization_id,content,wrapped_key,policy,created_by) SELECT id,'org',content,wrapped_key,$2::jsonb,'owner-member' FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,content jsonb,wrapped_key jsonb)", [JSON.stringify(rows), JSON.stringify(DEFAULT_PROJECT_POLICY)]);
    await migration.query("INSERT INTO cloud_work_project_grants(id,project_id,organization_id,member_id,role) SELECT grant_id,id,'org','owner-member','manager' FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,grant_id uuid)", [JSON.stringify(rows)]);
    try {
      const first = await cloud.projects.managementList(a("owner2"), {}, undefined, 50);
      expect(first.projects).toHaveLength(50); expect(first.total).toBeGreaterThanOrEqual(1000);
      expect(JSON.stringify(first.projects)).not.toContain("Private project instruction");
      let cursor: string | undefined, found = false, pages = 0;
      do { const page = await cloud.projects.managementList(a("owner2"), { query: "Management needle" }, cursor, 50); found ||= page.projects.some(value => value.name === "Management needle"); cursor = page.nextCursor ?? undefined; pages++; } while (cursor && pages < 30);
      expect(found).toBe(true); expect(pages).toBeGreaterThan(1);
      expect((await cloud.projects.managementList(a("owner2"), { projectId: rows[999]!.id })).projects).toHaveLength(1);
      await expect(cloud.projects.managementList(a("outside", "other"))).rejects.toMatchObject({ statusCode: 403 });
    } finally { await migration.query("DELETE FROM cloud_work_projects WHERE id=ANY($1::uuid[])", [rows.map(value => value.id)]); }
  }, 30000);
  it("preserves shared content after its creator leaves and supports recoverable lifecycle", async () => {
    const p = await create(); await share(p.id, [{ subjectId: "alice-member", role: "contributor" }]);
    const chat = await cloud.create(a("alice"), "Retain after departure", p.id);
    await identity.removeMember(headers, "alice-member");
    expect((await cloud.detail(a("owner"), chat.id)).conversation.title).toBe("Retain after departure");
    let detail = await cloud.projects.detail(a("owner"), p.id);
    await cloud.projects.lifecycle(a("owner"), p.id, "archived", detail.revision);
    await expect(cloud.create(a("owner"), "Blocked", p.id)).rejects.toMatchObject({ statusCode: 404 });
    detail = await cloud.projects.detail(a("owner"), p.id);
    await cloud.projects.lifecycle(a("owner"), p.id, "deleted", detail.revision);
    await expect(cloud.projects.detail(a("owner"), p.id)).rejects.toMatchObject({ statusCode: 404 });
    const inventory = await cloud.projects.list(a("owner"), true);
    await cloud.projects.lifecycle(a("owner"), p.id, "active", inventory.projects.find(p2 => p2.id === p.id)!.revision);
    expect((await cloud.detail(a("owner"), chat.id)).conversation.title).toBe("Retain after departure");
  });
});
