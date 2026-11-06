import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CloudWorkService } from "./service.js";
import { IdentityError } from "../auth/identity-service.js";
const Id = z.string().uuid();
const Revision = z.number().int().positive();
const Topic = z.string().trim().min(1).max(160);
const Content = z
  .string()
  .trim()
  .min(1)
  .max(12000)
  .refine((x) => Buffer.byteLength(x) <= 12000);
export function registerCloudMemoryRoutes(
  app: FastifyInstance,
  cloud: CloudWorkService,
) {
  const root = "/v1/work/cloud/memory";
  const actor = (req: FastifyRequest) => cloud.actor(req.headers);
  const mutation = async (req: FastifyRequest) => {
    if (
      !req.headers.authorization &&
      req.headers.origin !== new URL(cloud.config.publicUrl).origin
    )
      throw new IdentityError(
        403,
        "untrusted_origin",
        "This request came from an untrusted origin.",
      );
    const a = await actor(req);
    await cloud.throttleMutation(a.memberId);
    return a;
  };
  app.get(`${root}/settings`, async (req) =>
    cloud.memory.settings(await actor(req)),
  );
  app.patch(`${root}/settings`, async (req) => {
    const body = z
      .object({ enabled: z.boolean(), expectedRevision: Revision })
      .strict()
      .parse(req.body);
    return cloud.memory.updateSettings(
      await mutation(req),
      body.enabled,
      body.expectedRevision,
    );
  });
  app.get(root, async (req) => {
    const q = z
      .object({
        scope: z.enum(["personal", "conversation"]).optional(),
        conversationId: Id.optional(),
        q: z.string().max(500).optional(),
      })
      .strict()
      .parse(req.query);
    return cloud.memory.list(await actor(req), q);
  });
  app.post(root, async (req, reply) => {
    const input = z
      .object({
        requestId: Id,
        scope: z.enum(["personal", "conversation"]),
        conversationId: Id.optional(),
        topic: Topic,
        content: Content,
        sensitive: z.boolean().optional(),
        sourceMessageId: Id.optional(),
      })
      .strict()
      .parse(req.body);
    reply.code(201);
    return cloud.memory.create(await mutation(req), input);
  });
  app.patch(`${root}/:id`, async (req) => {
    const p = z.object({ id: Id }).strict().parse(req.params);
    const input = z
      .object({
        requestId: Id,
        expectedRevision: Revision,
        topic: Topic,
        content: Content,
        sensitive: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    return cloud.memory.edit(await mutation(req), p.id, input);
  });
  app.delete(`${root}/:id`, async (req, reply) => {
    const p = z.object({ id: Id }).strict().parse(req.params);
    const q = z
      .object({ expectedRevision: z.coerce.number().int().positive() })
      .strict()
      .parse(req.query);
    await cloud.memory.remove(await mutation(req), p.id, q.expectedRevision);
    return reply.code(204).send();
  });
}
