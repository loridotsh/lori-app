import { DESKTOP_PROTOCOL_VERSION } from "@lori-enterprise/contracts";
import { IdentityError } from "../auth/identity-service.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { IdentityService } from "../auth/identity-service.js";
import { assertBrowserOrigin } from "../auth/request-origin.js";
import type { UsageAnalyticsService } from "./service.js";

const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return (
      Number.isFinite(parsed) &&
      new Date(parsed).toISOString().startsWith(value)
    );
  }, "Invalid UTC date")
  .refine(
    (value) => value >= "2000-01-01",
    "Dates before 2000 are not supported",
  );
const LabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (value) => !/[\u0000-\u001F\u007F]/.test(value),
    "Control characters are not allowed",
  );
const AgentSchema = z.string().regex(/^[a-z0-9-]{1,32}$/);
const VersionSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/);
const CounterSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const SnapshotSchema = z
  .object({
    agentId: AgentSchema,
    appVersion: VersionSchema,
    cacheReadTokens: CounterSchema,
    cacheWriteTokens: CounterSchema,
    costCoveredTokens: CounterSchema,
    estimatedCostMicrousd: CounterSchema,
    inputTokens: CounterSchema,
    model: LabelSchema.optional(),
    outputTokens: CounterSchema,
    pricingVersion: VersionSchema,
    totalTurns: CounterSchema,
    usageDate: DateSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const totalTokens =
      BigInt(value.inputTokens) +
      BigInt(value.outputTokens) +
      BigInt(value.cacheReadTokens) +
      BigInt(value.cacheWriteTokens);
    if (BigInt(value.costCoveredTokens) > totalTokens) {
      context.addIssue({
        code: "custom",
        message: "Cost-covered tokens cannot exceed total tokens.",
        path: ["costCoveredTokens"],
      });
    }
  });
const BatchSchema = z
  .object({
    epoch: z.string().uuid(),
    snapshots: z.array(SnapshotSchema).min(1).max(250),
    sourceId: z.string().uuid(),
  })
  .strict();

const AnalyticsQuerySchema = z
  .object({
    agent: z.union([z.string(), z.array(z.string())]).optional(),
    from: DateSchema,
    model: z.union([z.string(), z.array(z.string())]).optional(),
    to: DateSchema,
    product: z.enum(["code", "work"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.from > value.to) {
      context.addIssue({
        code: "custom",
        message: "The start date must not be after the end date.",
      });
    }
    const today = new Date().toISOString().slice(0, 10);
    if (value.to > today) {
      context.addIssue({
        code: "custom",
        message: "The end date cannot be in the future.",
      });
    }
  });

function values(
  value: string | string[] | undefined,
  schema: z.ZodType<string>,
): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return z
    .array(schema)
    .max(20)
    .parse(list.map((item) => item.trim()).filter(Boolean));
}

function analyticsQuery(input: unknown) {
  const query = AnalyticsQuerySchema.parse(input);
  return {
    agents: values(query.agent, AgentSchema),
    from: query.from,
    models: values(query.model, LabelSchema),
    to: query.to,
    product: query.product,
  };
}

function csv(
  reply: { header(name: string, value: string): unknown },
  filename: string,
): void {
  reply.header("cache-control", "private, no-store");
  reply.header("content-disposition", `attachment; filename="${filename}"`);
  reply.header("content-type", "text/csv; charset=utf-8");
}

export function registerUsageAnalyticsRoutes(
  app: FastifyInstance,
  usage: UsageAnalyticsService,
  identity: IdentityService,
  config: AppConfig,
): void {
  app.post("/v1/desktop/usage", async (request, reply) => {
    await identity.enforceRateLimit(`desktop-usage:${request.ip}`, 120, 60);
    const body = BatchSchema.parse(request.body);
    reply.header("cache-control", "no-store");
    return usage.ingest(request.headers.authorization, body);
  });

  app.post("/v1/desktop/work/usage", async (request, reply) => {
    const protocol = request.headers["x-lori-protocol-version"];
    if (
      Array.isArray(protocol) ||
      Number(protocol) !== DESKTOP_PROTOCOL_VERSION
    ) {
      throw new IdentityError(
        426,
        "unsupported_desktop_protocol",
        "Unsupported desktop protocol.",
      );
    }
    await identity.enforceRateLimit(
      `desktop-work-usage:${request.ip}`,
      120,
      60,
    );
    const body = BatchSchema.extend({
      enrolledAt: z.iso.datetime({ offset: true }),
    })
      .strict()
      .parse(request.body);
    reply.header("cache-control", "no-store");
    return usage.ingest(request.headers.authorization, body, "work");
  });
  app.get("/v1/usage", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return usage.ownAnalytics(request.headers, analyticsQuery(request.query));
  });

  app.get("/v1/usage/export.csv", async (request, reply) => {
    await identity.enforceRateLimit(`usage-export:${request.ip}`, 10, 60);
    const result = await usage.ownAnalytics(
      request.headers,
      analyticsQuery(request.query),
    );
    csv(reply, "my-lori-usage.csv");
    return usage.analyticsCsv(result);
  });

  app.get("/v1/admin/usage", async (request, reply) => {
    const raw = z
      .object({ memberId: z.string().min(1).max(128).optional() })
      .passthrough()
      .parse(request.query);
    const query = { ...(request.query as Record<string, unknown>) };
    delete query.memberId;
    reply.header("cache-control", "private, no-store");
    return usage.adminAnalytics(
      request.headers,
      raw.memberId,
      analyticsQuery(query),
    );
  });

  app.get("/v1/admin/usage/export.csv", async (request, reply) => {
    await identity.enforceRateLimit(`admin-usage-export:${request.ip}`, 10, 60);
    const raw = z
      .object({ memberId: z.string().min(1).max(128).optional() })
      .passthrough()
      .parse(request.query);
    const query = { ...(request.query as Record<string, unknown>) };
    delete query.memberId;
    const result = await usage.adminAnalytics(
      request.headers,
      raw.memberId,
      analyticsQuery(query),
    );
    csv(
      reply,
      raw.memberId ? "member-lori-usage.csv" : "organization-lori-usage.csv",
    );
    return usage.analyticsCsv(result);
  });

  app.get("/v1/admin/usage/members", async (request, reply) => {
    const query = z
      .object({
        from: DateSchema,
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
        q: z.string().trim().max(100).default(""),
        sort: z.enum(["tokens", "cost", "activity"]).default("tokens"),
        product: z.enum(["code", "work"]).optional(),
        to: DateSchema,
      })
      .strict()
      .superRefine((value, context) => {
        if (value.from > value.to) {
          context.addIssue({
            code: "custom",
            message: "The start date must not be after the end date.",
          });
        }
        if (value.to > new Date().toISOString().slice(0, 10)) {
          context.addIssue({
            code: "custom",
            message: "The end date cannot be in the future.",
          });
        }
      })
      .parse(request.query);
    reply.header("cache-control", "private, no-store");
    return usage.members(request.headers, {
      agents: [],
      from: query.from,
      limit: query.limit,
      models: [],
      offset: query.offset,
      query: query.q,
      sort: query.sort,
      product: query.product,
      to: query.to,
    });
  });

  app.get("/v1/admin/usage/settings", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return usage.settings(request.headers);
  });

  app.patch("/v1/admin/usage/settings", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(
      `admin-usage-settings:${request.ip}`,
      30,
      60,
    );
    const body = z
      .object({
        collectionEnabled: z.boolean(),
        expectedRevision: z.number().int().positive(),
        memberVisibilityDefault: z.boolean(),
        retentionDays: z.union([
          z.literal(30),
          z.literal(90),
          z.literal(180),
          z.literal(365),
          z.null(),
        ]),
      })
      .strict()
      .parse(request.body);
    reply.header("cache-control", "no-store");
    return usage.updateSettings(request.headers, body);
  });

  app.get("/v1/admin/usage/members/:id/visibility", async (request, reply) => {
    const { id } = z
      .object({ id: z.string().min(1).max(128) })
      .parse(request.params);
    reply.header("cache-control", "private, no-store");
    return usage.memberVisibility(request.headers, id);
  });

  app.patch(
    "/v1/admin/usage/members/:id/visibility",
    async (request, reply) => {
      assertBrowserOrigin(request, config);
      await identity.enforceRateLimit(
        `admin-usage-visibility:${request.ip}`,
        60,
        60,
      );
      const { id } = z
        .object({ id: z.string().min(1).max(128) })
        .parse(request.params);
      const body = z
        .object({
          expectedRevision: z.number().int().positive(),
          override: z.enum(["inherit", "show", "hide"]),
        })
        .strict()
        .parse(request.body);
      reply.header("cache-control", "no-store");
      return usage.setMemberVisibility(
        request.headers,
        id,
        body.override,
        body.expectedRevision,
      );
    },
  );

  app.delete("/v1/admin/usage", async (request, reply) => {
    assertBrowserOrigin(request, config);
    await identity.enforceRateLimit(`admin-usage-delete:${request.ip}`, 5, 60);
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        memberId: z.string().min(1).max(128).optional(),
      })
      .strict()
      .parse(request.body);
    reply.header("cache-control", "no-store");
    return usage.deleteUsage(
      request.headers,
      body.expectedRevision,
      body.memberId,
    );
  });
}
