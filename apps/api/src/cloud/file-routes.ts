import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CloudActor, CloudWorkService } from "./service.js";
import { IdentityError } from "../auth/identity-service.js";
const Id = z.string().uuid();
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Version = z.coerce.number().int().positive();
export function registerCloudFileRoutes(
  app: FastifyInstance,
  cloud: CloudWorkService,
) {
  const actors = new WeakMap<FastifyRequest, CloudActor>();
  const transfers = new WeakSet<FastifyRequest>();
  let active = 0;
  const release = (req: FastifyRequest) => {
    if (transfers.has(req)) {
      transfers.delete(req);
      active--;
    }
  };
  app.addHook("onResponse", async (req) => release(req));
  app.addHook("onRequestAbort", async (req) => release(req));
  if (!app.hasContentTypeParser("application/octet-stream"))
    app.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: 20 * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
  const admit = async (req: FastifyRequest, write: boolean) => {
    if (
      write &&
      !req.headers.authorization &&
      req.headers.origin !== new URL(cloud.config.publicUrl).origin
    )
      throw new IdentityError(
        403,
        "untrusted_origin",
        "This request came from an untrusted origin.",
      );
    const actor = await cloud.actor(req.headers);
    await cloud.throttleMutation(actor.memberId);
    await cloud.transaction(async (c) => {
      await cloud.ensure(c, actor);
      const id = z.object({ id: Id }).strict().parse(req.params).id;
      if (req.url.startsWith("/v1/work/cloud/conversations/"))
        await cloud.ownConversation(c, actor, id);
      else await cloud.files.fileTx(c, actor, id);
    });
    if (
      (req.method === "POST" || req.method === "PUT") &&
      req.headers["content-type"]?.split(";")[0] !== "application/octet-stream"
    )
      throw new IdentityError(
        415,
        "cloud_upload_content_type",
        "Use application/octet-stream for file uploads.",
      );
    if (active >= 4)
      throw new IdentityError(
        429,
        "cloud_transfer_busy",
        "Cloud file transfers are busy. Retry shortly.",
      );
    active++;
    transfers.add(req);
    actors.set(req, actor);
  };
  const params = (value: unknown) => z.object({ id: Id }).strict().parse(value);
  const root = "/v1/work/cloud";
  app.get(`${root}/conversations/:id/files`, async (req) =>
    cloud.files.list(await cloud.actor(req.headers), params(req.params).id),
  );
  app.post(
    `${root}/conversations/:id/files`,
    { bodyLimit: 20 * 1024 * 1024, onRequest: async (req) => admit(req, true) },
    async (req, reply) => {
      const q = z
        .object({
          path: z.string().min(1).max(240),
          requestId: Id,
          mimeType: z
            .string()
            .regex(
              /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/i,
            )
            .default("application/octet-stream"),
        })
        .strict()
        .parse(req.query);
      if (!Buffer.isBuffer(req.body))
        throw new IdentityError(
          415,
          "cloud_upload_content_type",
          "Use application/octet-stream for file uploads.",
        );
      reply.code(201);
      return cloud.files.upload(
        actors.get(req)!,
        params(req.params).id,
        q.path,
        q.mimeType,
        req.body,
        q.requestId,
      );
    },
  );
  app.get(
    `${root}/files/:id/content`,
    { onRequest: async (req) => admit(req, false) },
    async (req, reply) => {
      const query = z.object({ download: z.enum(["true", "false"]).optional() })
        .strict()
        .parse(req.query);
      const { file, bytes } = await cloud.files.download(
        actors.get(req)!,
        params(req.params).id,
        query.download !== "false",
      );
      reply.header("content-type", file.mimeType);
      reply.header("x-content-type-options", "nosniff");
      reply.header("content-security-policy", "sandbox; default-src 'none'");
      reply.header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.path.split("/").at(-1)!)}`,
      );
      reply.header("etag", `"${file.sha256}"`);
      reply.header("accept-ranges", "bytes");
      // Video players ask for ranges so they can seek, and Safari needs them to play at all.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (range && (range[1] || range[2]) && bytes.length) {
        const start = range[1] ? Number(range[1]) : Math.max(bytes.length - Number(range[2]), 0);
        const end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        if (start > end || start >= bytes.length) {
          reply.header("content-range", `bytes */${bytes.length}`);
          return reply.code(416).send();
        }
        reply.header("content-range", `bytes ${start}-${end}/${bytes.length}`);
        return reply.code(206).send(bytes.subarray(start, end + 1));
      }
      return reply.send(bytes);
    },
  );
  app.get(
    `${root}/files/:id/text`,
    { onRequest: async (req) => admit(req, false) },
    async (req) => {
      const q = z
        .object({
          offset: z.coerce.number().int().min(0).max(20971520).default(0),
          startLine: z.coerce.number().int().min(1).max(1000000).default(1),
          limit: z.coerce.number().int().min(1).max(1000).default(1000),
        })
        .strict()
        .parse(req.query);
      return cloud.files.text(
        actors.get(req)!,
        params(req.params).id,
        q.startLine,
        q.limit,
        q.offset,
      );
    },
  );
  app.patch(
    `${root}/files/:id`,
    { bodyLimit: 8 * 1024 * 1024, onRequest: async (req) => admit(req, true) },
    async (req) => {
      const body = z
        .object({
          requestId: Id,
          expectedVersion: Version,
          expectedHash: Hash,
          text: z
            .string()
            .max(1048576)
            .refine((x) => Buffer.byteLength(x) <= 1048576),
          path: z.string().min(1).max(240).optional(),
        })
        .strict()
        .parse(req.body);
      return cloud.files.edit(actors.get(req)!, params(req.params).id, body);
    },
  );
  app.put(
    `${root}/files/:id/content`,
    { bodyLimit: 20 * 1024 * 1024, onRequest: async (req) => admit(req, true) },
    async (req) => {
      const q = z
        .object({
          requestId: Id,
          expectedVersion: Version,
          expectedHash: Hash,
        })
        .strict()
        .parse(req.query);
      if (!Buffer.isBuffer(req.body))
        throw new IdentityError(
          415,
          "cloud_upload_content_type",
          "Use application/octet-stream for file uploads.",
        );
      return cloud.files.replaceContent(actors.get(req)!, params(req.params).id, {
        bytes: req.body,
        ...q,
      });
    },
  );
  app.delete(
    `${root}/files/:id`,
    { onRequest: async (req) => admit(req, true) },
    async (req, reply) => {
      const q = z
        .object({ expectedVersion: Version, expectedHash: Hash })
        .strict()
        .parse(req.query);
      await cloud.files.remove(
        actors.get(req)!,
        params(req.params).id,
        q.expectedVersion,
        q.expectedHash,
      );
      return reply.code(204).send();
    },
  );

  app.get(
    `${root}/runs/:id/tools/:invocationId/outputs`,
    {
      onRequest: async (req) => {
        const a = await cloud.actor(req.headers);
        await cloud.throttleRead(a.memberId);
        if (active >= 4)
          throw new IdentityError(
            429,
            "cloud_transfer_busy",
            "Cloud file transfers are busy. Retry shortly.",
          );
        active++;
        transfers.add(req);
        actors.set(req, a);
      },
    },
    async (req, reply) => {
      const p = z
        .object({ id: Id, invocationId: Id })
        .strict()
        .parse(req.params);
      const q = z
        .object({ path: z.string().min(1).max(240) })
        .strict()
        .parse(req.query);
      const output = await cloud.tools.stagedOwned(
        actors.get(req)!,
        p.id,
        p.invocationId,
        q.path,
      );
      reply.header("content-type", "application/octet-stream");
      reply.header("x-content-type-options", "nosniff");
      reply.header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(output.path.split("/").at(-1)!)}`,
      );
      reply.header("etag", `"${output.sha256}"`);
      return reply.send(output.bytes);
    },
  );
  const internal = "/v1/internal/work/cloud/runs";
  const executionParams = (value: unknown) =>
    z
      .object({ id: Id, invocationId: Id, fileId: Id.optional() })
      .strict()
      .parse(value);
  const executionAdmit = async (req: FastifyRequest) => {
    const p = executionParams(req.params);
    const claims = cloud.claims(req.headers.authorization, p.id);
    await cloud.provider(claims);
    if (
      req.method === "POST" &&
      req.headers["content-type"]?.split(";")[0] !== "application/octet-stream"
    )
      throw new IdentityError(
        415,
        "cloud_upload_content_type",
        "Use application/octet-stream for output uploads.",
      );
    if (active >= 4)
      throw new IdentityError(
        429,
        "cloud_transfer_busy",
        "Cloud file transfers are busy. Retry shortly.",
      );
    active++;
    transfers.add(req);
  };
  app.post(`${internal}/:id/tools/:invocationId/start`, async (req) => {
    const p = executionParams(req.params);
    z.object({})
      .strict()
      .parse(req.body ?? {});
    return cloud.tools.start(
      cloud.claims(req.headers.authorization, p.id),
      p.invocationId,
    );
  });
  app.get(
    `${internal}/:id/tools/:invocationId/inputs/:fileId`,
    { onRequest: executionAdmit },
    async (req, reply) => {
      const p = executionParams(req.params);
      const result = await cloud.tools.input(
        cloud.claims(req.headers.authorization, p.id),
        p.invocationId,
        p.fileId!,
      );
      reply.header("content-type", "application/octet-stream");
      return reply.send(result.bytes);
    },
  );
  app.post(
    `${internal}/:id/tools/:invocationId/outputs`,
    { bodyLimit: 20 * 1024 * 1024, onRequest: executionAdmit },
    async (req) => {
      const p = executionParams(req.params);
      const q = z
        .object({ path: z.string().min(1).max(240), sha256: Hash })
        .strict()
        .parse(req.query);
      if (!Buffer.isBuffer(req.body))
        throw new IdentityError(
          415,
          "cloud_upload_content_type",
          "Use application/octet-stream for output uploads.",
        );
      return cloud.tools.stage(
        cloud.claims(req.headers.authorization, p.id),
        p.invocationId,
        q.path,
        q.sha256,
        req.body,
      );
    },
  );
  app.post(
    `${internal}/:id/tools/:invocationId/result`,
    { bodyLimit: 3 * 1024 * 1024 },
    async (req) => {
      const p = executionParams(req.params);
      const body = z
        .object({ output: z.json(), failed: z.boolean().optional() })
        .strict()
        .parse(req.body);
      return cloud.tools.result(
        cloud.claims(req.headers.authorization, p.id),
        p.invocationId,
        body,
      );
    },
  );
  app.addHook("onClose", async () => cloud.files.close());
}
