import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { IdentityError } from "../../auth/identity-service.js";
import type { CloudActor, CloudWorkService } from "../service.js";

const Id = z.string().uuid();
const Revision = z.number().int().positive();
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Version = z.coerce.number().int().positive();
const Mime = z
  .string()
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/i)
  .default("application/octet-stream");
const Fields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000),
  instructions: z.string().max(12000).refine((value) => Buffer.byteLength(value) <= 48000),
};
const Status = z.enum(["active", "archived", "deleted"]);
const ProjectParams = z.object({ id: Id }).strict();
const ReferenceParams = z.object({ id: Id, referenceId: Id }).strict();
const ROOT = "/v1/work/cloud/personal-projects";

/** The owner-only API. Every handler resolves the owner from the verified session or device, never from the request. */
export function registerPersonalProjectRoutes(app: FastifyInstance, cloud: CloudWorkService) {
  const personal = cloud.personalProjects;
  const actor = (req: FastifyRequest) => cloud.actor(req.headers);
  const trustedOrigin = (req: FastifyRequest) => {
    if (!req.headers.authorization && req.headers.origin !== new URL(cloud.config.publicUrl).origin)
      throw new IdentityError(403, "untrusted_origin", "This request came from an untrusted origin.");
  };
  const mutation = async (req: FastifyRequest) => {
    trustedOrigin(req);
    const a = await actor(req);
    await cloud.throttleMutation(a.memberId);
    return a;
  };
  const read = async (req: FastifyRequest) => {
    const a = await actor(req);
    await cloud.throttleRead(a.memberId);
    return a;
  };

  app.get(`${ROOT}/capabilities`, async (req) => personal.capabilities(await actor(req)));

  app.get(`${ROOT}/directory`, async (req) => personal.directory(await actor(req)));
  app.get(`${ROOT}/policy`, async (req) => personal.policy(await actor(req)));
  app.put(`${ROOT}/policy`, async (req) => {
    const body = z
      .object({
        expectedRevision: Revision,
        allowAll: z.boolean(),
        grants: z.array(z.object({ kind: z.enum(["member", "team"]), subjectId: z.string().min(1).max(128) }).strict()).max(2500),
        blockedMemberIds: z.array(z.string().min(1).max(128)).max(2500),
        maxPerMember: z.number().int().min(1).max(1000).nullable(),
      })
      .strict()
      .parse(req.body);
    return personal.setPolicy(await mutation(req), body);
  });
  app.get(`${ROOT}/policy/effective`, async (req) => {
    const q = z.object({ memberId: z.string().min(1).max(128) }).strict().parse(req.query);
    return personal.effective(await actor(req), q.memberId);
  });

  app.get(ROOT, async (req) => {
    const q = z
      .object({ status: Status.default("active"), cursor: Id.optional(), limit: z.coerce.number().int().min(1).max(50).default(30) })
      .strict()
      .parse(req.query);
    return personal.list(await read(req), q);
  });
  app.post(ROOT, async (req, reply) => {
    const body = z
      .object({ requestId: Id, name: Fields.name, description: Fields.description.default(""), instructions: Fields.instructions.default("") })
      .strict()
      .parse(req.body);
    reply.code(201);
    return personal.create(await mutation(req), body);
  });
  app.get(`${ROOT}/:id`, async (req) => personal.detail(await read(req), ProjectParams.parse(req.params).id));
  app.patch(`${ROOT}/:id`, async (req) => {
    const body = z
      .object({ requestId: Id.optional(), expectedRevision: Revision, name: Fields.name.optional(), description: Fields.description.optional(), instructions: Fields.instructions.optional() })
      .strict()
      .parse(req.body);
    return personal.update(await mutation(req), ProjectParams.parse(req.params).id, body);
  });
  app.post(`${ROOT}/:id/lifecycle`, async (req) => {
    const body = z.object({ requestId: Id, status: Status, expectedRevision: Revision }).strict().parse(req.body);
    return personal.lifecycle(await mutation(req), ProjectParams.parse(req.params).id, body);
  });

  app.get(`${ROOT}/:id/conversations`, async (req) => {
    const q = z.object({ cursor: Id.optional(), limit: z.coerce.number().int().min(1).max(50).default(30) }).strict().parse(req.query);
    return cloud.list(await read(req), q.limit, q.cursor, undefined, ProjectParams.parse(req.params).id);
  });
  app.post(`${ROOT}/:id/conversations`, async (req, reply) => {
    const body = z.object({ title: z.string().trim().min(1).max(200).default("New conversation"), requestId: Id.optional() }).strict().parse(req.body ?? {});
    reply.code(201);
    return personal.createConversation(await mutation(req), ProjectParams.parse(req.params).id, body);
  });
  // Moves a private chat into, between or out of personal projects (null files it outside any project).
  app.put("/v1/work/cloud/conversations/:id/personal-project", async (req) => {
    const body = z.object({ requestId: Id, personalProjectId: Id.nullable(), expectedRevision: Revision }).strict().parse(req.body);
    return personal.moveConversation(await mutation(req), ProjectParams.parse(req.params).id, body);
  });

  // ---- Reference files ----
  if (!app.hasContentTypeParser("application/octet-stream"))
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 20 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  const actors = new WeakMap<FastifyRequest, CloudActor>();
  const transfers = new WeakSet<FastifyRequest>();
  let active = 0;
  const release = (req: FastifyRequest) => {
    if (transfers.delete(req)) active--;
  };
  app.addHook("onResponse", async (req) => release(req));
  app.addHook("onRequestAbort", async (req) => release(req));
  const admit = (write: boolean) => async (req: FastifyRequest) => {
    if (write) trustedOrigin(req);
    const a = await actor(req);
    await cloud.throttleMutation(a.memberId);
    if ((req.method === "POST" || req.method === "PUT") && req.headers["content-type"]?.split(";")[0] !== "application/octet-stream")
      throw new IdentityError(415, "cloud_upload_content_type", "Use application/octet-stream for file uploads.");
    if (active >= 4) throw new IdentityError(429, "cloud_transfer_busy", "Cloud file transfers are busy. Retry shortly.");
    active++;
    transfers.add(req);
    actors.set(req, a);
  };
  /** The reference must belong to the project in the path; a mismatch is the same 404 as an unknown id. */
  const inProject = async (a: CloudActor, projectId: string, referenceId: string) => {
    const reference = await personal.references.get(a, referenceId);
    if (reference.projectId !== projectId) throw new IdentityError(404, "personal_project_reference_not_found", "Reference file was not found.");
    return reference;
  };

  app.get(`${ROOT}/:id/references`, async (req) => personal.references.list(await read(req), ProjectParams.parse(req.params).id));
  app.post(`${ROOT}/:id/references`, { bodyLimit: 20 * 1024 * 1024, onRequest: admit(true) }, async (req, reply) => {
    const q = z.object({ name: z.string().min(1).max(200), requestId: Id, mimeType: Mime }).strict().parse(req.query);
    if (!Buffer.isBuffer(req.body)) throw new IdentityError(415, "cloud_upload_content_type", "Use application/octet-stream for file uploads.");
    reply.code(201);
    return personal.references.upload(actors.get(req)!, ProjectParams.parse(req.params).id, { name: q.name, mimeType: q.mimeType, bytes: req.body, requestId: q.requestId });
  });
  app.get(`${ROOT}/:id/references/:referenceId`, async (req) => {
    const p = ReferenceParams.parse(req.params);
    return inProject(await read(req), p.id, p.referenceId);
  });
  app.get(`${ROOT}/:id/references/:referenceId/content`, { onRequest: admit(false) }, async (req, reply) => {
    const p = ReferenceParams.parse(req.params);
    const a = actors.get(req)!;
    await inProject(a, p.id, p.referenceId);
    const { reference, bytes } = await personal.references.download(a, p.referenceId);
    reply.header("content-type", reference.mimeType);
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-security-policy", "sandbox; default-src 'none'");
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(reference.name)}`);
    reply.header("etag", `"${reference.sha256}"`);
    return reply.send(bytes);
  });
  app.get(`${ROOT}/:id/references/:referenceId/text`, { onRequest: admit(false) }, async (req) => {
    const p = ReferenceParams.parse(req.params);
    const q = z
      .object({
        offset: z.coerce.number().int().min(0).max(20971520).default(0),
        startLine: z.coerce.number().int().min(1).max(1000000).default(1),
        limit: z.coerce.number().int().min(1).max(1000).default(1000),
      })
      .strict()
      .parse(req.query);
    const a = actors.get(req)!;
    await inProject(a, p.id, p.referenceId);
    return personal.references.text(a, p.referenceId, q.startLine, q.limit, q.offset);
  });
  app.put(`${ROOT}/:id/references/:referenceId/content`, { bodyLimit: 20 * 1024 * 1024, onRequest: admit(true) }, async (req) => {
    const p = ReferenceParams.parse(req.params);
    const q = z.object({ requestId: Id, expectedVersion: Version, expectedHash: Hash, mimeType: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/i).optional() }).strict().parse(req.query);
    if (!Buffer.isBuffer(req.body)) throw new IdentityError(415, "cloud_upload_content_type", "Use application/octet-stream for file uploads.");
    const a = actors.get(req)!;
    await inProject(a, p.id, p.referenceId);
    return personal.references.replace(a, p.referenceId, { bytes: req.body, ...q });
  });
  app.delete(`${ROOT}/:id/references/:referenceId`, async (req, reply) => {
    const p = ReferenceParams.parse(req.params);
    const q = z.object({ expectedVersion: Version, expectedHash: Hash }).strict().parse(req.query);
    const a = await mutation(req);
    await inProject(a, p.id, p.referenceId);
    await personal.references.remove(a, p.referenceId, q.expectedVersion, q.expectedHash);
    return reply.code(204).send();
  });
}
