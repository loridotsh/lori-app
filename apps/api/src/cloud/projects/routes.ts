import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { PROJECT_ACTIONS } from "@lori-enterprise/contracts";
import type { CloudWorkService } from "../service.js";
import { IdentityError } from "../../auth/identity-service.js";
import { requireDesktopProjectProtocol } from "./protocol.js";

const Id = z.string().uuid(), Revision = z.number().int().positive();
const Params = z.object({ projectId: Id }).strict();
const Description = { name: z.string().trim().min(1).max(100), description: z.string().trim().max(2000).default(""), instructions: z.string().max(12000).default("") };
const Mode = z.enum(["inherit", "assigned"]);
const Policy = z.object({ memoryEnabled: z.boolean(), forceAskMe: z.boolean(), exportsAllowed: z.boolean(), externalWritesAllowed: z.boolean(), managersManageMembers: z.boolean(), managersManageConnections: z.boolean(), providerModels: z.array(z.object({ providerId: z.string().min(1).max(128), modelIds: z.array(z.string().min(1).max(200)).max(100) }).strict()).max(100), pluginIds: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(100), providerMode: Mode.optional(), pluginMode: Mode.optional(), skillMode: Mode.optional(), skillIds: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(100).optional() }).strict();
const Memory = { topic: z.string().trim().min(1).max(160), content: z.string().trim().min(1).max(12000).refine(v => Buffer.byteLength(v) <= 12000), sensitive: z.boolean().optional(), sourceMessageId: Id.optional() };
export function registerProjectRoutes(app: FastifyInstance, cloud: CloudWorkService) {
  const root = "/v1/work/cloud/projects";
  const actor = async (req: FastifyRequest) => {
    const value = await cloud.actor(req.headers);
    if (value.deviceId && req.url.split("?")[0] !== `${root}/capabilities`) requireDesktopProjectProtocol(req.headers);
    if (value.deviceId && !cloud.config.cloud?.desktopProjectsEnabled && req.url.split("?")[0] !== `${root}/capabilities`)
      throw new IdentityError(503, "projects_unavailable", "Desktop projects are not enabled on this Enterprise server.");
    return value;
  };
  const mutation = async (req: FastifyRequest) => {
    if (!req.headers.authorization && req.headers.origin !== new URL(cloud.config.publicUrl).origin) throw new IdentityError(403, "untrusted_origin", "This request came from an untrusted origin.");
    const a = await actor(req); await cloud.throttleMutation(a.memberId); return a;
  };
  app.get(`${root}/capabilities`, async req => cloud.projects.capabilities(await actor(req)));
  app.get(`${root}/management`, async req => {
    const q = z.object({ projectId: Id.optional(), cursor: Id.optional(), limit: z.coerce.number().int().min(1).max(50).default(50), query: z.string().trim().max(200).optional(), status: z.enum(["active", "archived", "deleted"]).optional(), teamId: z.string().min(1).max(128).optional(), memberId: z.string().min(1).max(128).optional() }).strict().parse(req.query);
    const a = await actor(req); await cloud.throttleRead(a.memberId);
    return cloud.projects.managementList(a, { projectId: q.projectId, query: q.query, status: q.status, teamId: q.teamId, memberId: q.memberId }, q.cursor, q.limit);
  });
  app.get(`${root}/directory`, async req => { const q = z.object({ projectId: Id.optional() }).strict().parse(req.query); return cloud.projects.directory(await actor(req), q.projectId); });
  app.get(`${root}/creation-policy`, async req => cloud.projects.creationPolicy(await actor(req)));
  app.put(`${root}/creation-policy`, async req => cloud.projects.creationPolicy(await mutation(req), z.object({ expectedRevision: Revision, grants: z.array(z.object({ kind: z.enum(["member", "team"]), subjectId: z.string().min(1).max(128) }).strict()).max(2500) }).strict().parse(req.body)));
  app.get(root, async req => {
    const q = z.object({ admin: z.enum(["true", "false"]).optional(), cursor: Id.optional(), limit: z.coerce.number().int().min(1).max(50).default(50) }).strict().parse(req.query);
    return cloud.projects.list(await actor(req), q.admin === "true", q.cursor, q.limit);
  });
  app.post(root, async (req, reply) => { const input = z.object({ ...Description, requestId: Id }).strict().parse(req.body); reply.code(201); return cloud.projects.create(await mutation(req), input); });
  app.get(`${root}/:projectId`, async req => cloud.projects.detail(await actor(req), Params.parse(req.params).projectId));
  app.get(`${root}/:projectId/directory`, async req => cloud.projects.directory(await actor(req), Params.parse(req.params).projectId));
  app.get(`${root}/:projectId/preferences`, async req => cloud.preferences.get(await actor(req), Params.parse(req.params).projectId));
  app.patch(`${root}/:projectId/preferences`, async req => cloud.preferences.update(await mutation(req), z.object({ approvalMode: z.enum(["askMe", "approveForMe"]), expectedRevision: Revision }).strict().parse(req.body), Params.parse(req.params).projectId));
  app.patch(`${root}/:projectId`, async req => cloud.projects.update(await mutation(req), Params.parse(req.params).projectId, z.object({ name: Description.name.optional(), description: z.string().max(2000).optional(), instructions: z.string().max(12000).optional(), policy: Policy.optional(), expectedRevision: Revision }).strict().parse(req.body)));
  app.post(`${root}/:projectId/lifecycle`, async req => { const b = z.object({ status: z.enum(["active", "archived", "deleted"]), expectedRevision: Revision }).strict().parse(req.body); return cloud.projects.lifecycle(await mutation(req), Params.parse(req.params).projectId, b.status, b.expectedRevision); });
  app.get(`${root}/:projectId/governance`, async req => cloud.projects.governance(await actor(req), Params.parse(req.params).projectId));
  app.get(`${root}/:projectId/members/:memberId/effective`, async req => { const p = z.object({ projectId: Id, memberId: z.string().min(1).max(128) }).strict().parse(req.params); return cloud.projects.permissionPreview(await actor(req), p.projectId, p.memberId); });
  app.get(`${root}/:projectId/members`, async req => cloud.projects.memberships(await actor(req), Params.parse(req.params).projectId));
  app.put(`${root}/:projectId/members`, async req => cloud.projects.setMemberships(await mutation(req), Params.parse(req.params).projectId, z.object({ expectedRevision: Revision, grants: z.array(z.object({ kind: z.enum(["member", "team"]), subjectId: z.string().min(1).max(128), role: z.enum(["viewer", "contributor", "manager"]), deniedActions: z.array(z.enum(PROJECT_ACTIONS)).max(PROJECT_ACTIONS.length).default([]) }).strict()).max(2500), blocks: z.array(z.string().min(1).max(128)).max(2500) }).strict().parse(req.body)));
  app.post(`${root}/:projectId/admin-access`, async req => cloud.projects.adminAccess(await mutation(req), Params.parse(req.params).projectId, z.object({ reason: z.string().trim().min(10).max(1000) }).strict().parse(req.body).reason));
  app.get(`${root}/:projectId/conversations`, async req => { const q = z.object({ cursor: Id.optional(), limit: z.coerce.number().int().min(1).max(50).default(30) }).strict().parse(req.query); return cloud.list(await actor(req), q.limit, q.cursor, Params.parse(req.params).projectId); });
  app.post(`${root}/:projectId/conversations`, async (req, reply) => { const b = z.object({ title: z.string().trim().min(1).max(200).default("New conversation"), requestId: Id.optional() }).strict().parse(req.body ?? {}); reply.code(201); return cloud.create(await mutation(req), b.title, Params.parse(req.params).projectId, b.requestId); });
  app.get(`${root}/:projectId/memory`, async req => {
    const a = await actor(req), id = Params.parse(req.params).projectId;
    return cloud.transaction(async c => { await cloud.ensure(c, a); return { notes: await cloud.projectMemory.listTx(c, a, id) }; });
  });
  app.post(`${root}/:projectId/memory`, async req => {
    const a = await mutation(req), id = Params.parse(req.params).projectId, b = z.object({ ...Memory, requestId: Id }).strict().parse(req.body);
    return cloud.transaction(async c => { await cloud.ensure(c, a); return cloud.projectMemory.saveTx(c, a, id, b.requestId, b); });
  });
  app.patch(`${root}/:projectId/memory/:id`, async req => {
    const a = await mutation(req), p = z.object({ projectId: Id, id: Id }).strict().parse(req.params), b = z.object({ ...Memory, expectedRevision: Revision }).strict().parse(req.body);
    return cloud.transaction(async c => { await cloud.ensure(c, a); return cloud.projectMemory.saveTx(c, a, p.projectId, p.id, b, b.expectedRevision); });
  });
  app.delete(`${root}/:projectId/memory/:id`, async (req, reply) => {
    const p = z.object({ projectId: Id, id: Id }).strict().parse(req.params), q = z.object({ expectedRevision: z.coerce.number().int().positive() }).strict().parse(req.query);
    await cloud.projectMemory.remove(await mutation(req), p.projectId, p.id, q.expectedRevision); return reply.code(204).send();
  });
  app.get(`${root}/:projectId/search`, async req => {
    const a = await actor(req), id = Params.parse(req.params).projectId, q = z.object({ q: z.string().trim().min(1).max(500) }).strict().parse(req.query);
    await cloud.throttleRead(a.memberId);
    return cloud.transaction(async c => { await cloud.ensure(c, a); return cloud.projectRetrieval.searchTx(c, a, id, q.q); });
  });
  const pluginParams = z.object({ projectId: Id, id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) }).strict();
  const projectActor = async (req: FastifyRequest, write = false) => ({ ...await (write ? mutation(req) : actor(req)), projectId: Id.parse((req.params as { projectId: string }).projectId), ...(write ? { projectManagement: true } : {}) });
  app.get(`${root}/:projectId/extensions`, async req => { const q = z.object({ management: z.literal("true").optional() }).strict().parse(req.query); return cloud.extensions.snapshot({ ...await projectActor(req), ...(q.management ? { projectManagement: true } : {}) }); });
  app.patch(`${root}/:projectId/extensions/skills/:id`, async req => { const p = pluginParams.parse(req.params); return cloud.extensions.setSkill(await projectActor(req, true), p.id, z.object({ enabled: z.boolean() }).strict().parse(req.body).enabled); });
  app.post(`${root}/:projectId/extensions/plugins/:id/token`, { bodyLimit: 20000 }, async req => {
    const p = pluginParams.parse(req.params), b = z.object({ token: z.string().min(1).max(8192), projectDedicatedAccount: z.literal(true) }).strict().parse(req.body);
    return cloud.extensions.connectToken(await projectActor(req, true), p.id, b.token);
  });
  app.post(`${root}/:projectId/extensions/plugins/:id/oauth`, { bodyLimit: 20000 }, async req => {
    const p = pluginParams.parse(req.params), b = z.object({ clientId: z.string().min(1).max(4096).optional(), clientSecret: z.string().min(1).max(8192).optional(), projectDedicatedAccount: z.literal(true) }).strict().parse(req.body);
    return cloud.extensions.oauth.begin(await projectActor(req, true), p.id, b);
  });
  app.post(`${root}/:projectId/extensions/plugins/:id/refresh`, async req => { const p = pluginParams.parse(req.params); return cloud.extensions.refreshConnection(await projectActor(req, true), p.id, z.object({ expectedRevision: Revision }).strict().parse(req.body).expectedRevision); });
  app.patch(`${root}/:projectId/extensions/plugins/:id`, async req => { const p = pluginParams.parse(req.params), b = z.object({ expectedRevision: Revision, enabled: z.boolean() }).strict().parse(req.body); return cloud.extensions.setEnabled(await projectActor(req, true), p.id, b.expectedRevision, b.enabled); });
  app.delete(`${root}/:projectId/extensions/plugins/:id`, async req => { const p = pluginParams.parse(req.params); return cloud.extensions.disconnect(await projectActor(req, true), p.id, z.object({ expectedRevision: Revision }).strict().parse(req.body).expectedRevision); });
}
