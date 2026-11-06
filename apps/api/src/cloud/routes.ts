import { cachedWorkModels, resolveWorkPricing } from "../auth/work-model-discovery.js";
import type { CloudReportedUsage } from "@lori-enterprise/contracts";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerResponse } from "node:http";
import { Readable, Transform } from "node:stream";
import { z } from "zod";
import { IdentityError } from "../auth/identity-service.js";
import { workCredentialRedactor } from "../auth/provider-gateway-routes.js";
import {
  reasoningDisabledFor,
  rejectsReasoningWithTools,
  rememberReasoningDisabled,
  withReasoningDisabled,
} from "./provider-compat.js";
import {
  MAX_RESPONSE_TOKENS,
  outputBudgetParams,
} from "./model-limits.js";
import { providerGatewayDefinition } from "../catalog.js";
import { currentModelLine, PROMPT_PRIVACY } from "./agent-context.js";
import { MAX_ROUNDS } from "./run-budget.js";
import { readProviderRefusal } from "./provider-refusal.js";
import { mediaPrompt, mediaStream } from "./media.js";
import { outputCeilingFromRefusal, refusesOutputBudget } from "./model-limit-discovery.js";
import {
  mentionsContextOverflow,
  mentionsUnknownModel,
  providerFailureFor,
  upstreamErrorFields,
  type CloudWorkService,
} from "./service.js";
import { cloudUsageObserver, type CloudUsageContext } from "./usage.js";
import { registerNotificationRoutes } from "./notifications.js";
import { registerCloudMemoryRoutes } from "./memory-routes.js";
import { registerCloudFileRoutes } from "./file-routes.js";
import { registerCloudPreviewRoutes } from "./preview-routes.js";
import { registerProjectRoutes } from "./projects/routes.js";
import { registerPersonalProjectRoutes } from "./personal-projects/routes.js";
const Id = z.string().uuid();
const Revision = z.number().int().positive();
const Title = z.string().trim().min(1).max(200);
const Text = z
  .string()
  .min(1)
  .max(60000)
  .refine((x) => Buffer.byteLength(x) <= 60000);
const RunParams = z.object({ id: Id }).strict();
const Cursor = z.coerce.number().int().min(0).max(2147483647);
const Empty = z.object({}).strict();
const ROOT = "/v1/work/cloud";
const INTERNAL = "/v1/internal/work/cloud";
export function registerCloudWorkRoutes(
  app: FastifyInstance,
  cloud: CloudWorkService,
) {
  registerNotificationRoutes(app, cloud);
  registerProjectRoutes(app, cloud);
  registerCloudFileRoutes(app, cloud);
  registerPersonalProjectRoutes(app, cloud);
  registerCloudPreviewRoutes(app, cloud);
  registerCloudMemoryRoutes(app, cloud);
  cloud.extensions.registerRoutes(app);
  const controllers = new Set<AbortController>();
  const streams = new Set<ServerResponse>();
  app.addHook("preClose", async () => {
    await cloud.tools.close();
    for (const c of controllers) c.abort();
    for (const s of streams) s.end();
  });
  const actor = (req: FastifyRequest) => cloud.actor(req.headers);
  const mutation = async (req: FastifyRequest) => {
    // Canonical Origin only. Neither a path-bearing Origin nor Referer can authorize Cloud writes.
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
    await appRate(req, a.memberId);
    return a;
  };
  const appRate = async (_req: FastifyRequest, member: string) =>
    cloud.throttleMutation(member);
  const noStore = async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "private, no-store");
  };
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith(ROOT) || req.url.startsWith(INTERNAL))
      await noStore(req, reply);
  });
  app.get(`${ROOT}/capabilities`, async (req) =>
    cloud.capabilities(await actor(req)),
  );
  app.get(`${ROOT}/settings`, async (req) => cloud.settings(await actor(req)));
  app.patch(`${ROOT}/settings`, async (req) => {
    const body = z
      .object({
        // Accepted for older clients and ignored: Cloud Work availability
        // follows the organization's Work policy (Manage Work Access).
        enabled: z.boolean().optional(),
        retentionDays: z.number().int().min(1).max(365),
        expectedRevision: Revision,
      })
      .strict()
      .parse(req.body);
    return cloud.updateSettings(await mutation(req), {
      retentionDays: body.retentionDays,
      expectedRevision: body.expectedRevision,
    });
  });
  app.get(`${ROOT}/preferences`, async (req) => cloud.preferences.get(await actor(req)));
  app.patch(`${ROOT}/preferences`, async (req) => {
    const input = z.object({ approvalMode: z.enum(["askMe", "approveForMe"]), expectedRevision: Revision }).strict().parse(req.body);
    return cloud.preferences.update(await mutation(req), input);
  });
  app.get(`${ROOT}/conversations`, async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(50).default(30),
        cursor: Id.optional(),
        // "unfiled" is the Conversations group; the default lists every private conversation, as before personal projects.
        placement: z.enum(["all", "unfiled"]).default("all"),
      })
      .strict()
      .parse(req.query);
    return cloud.list(await actor(req), q.limit, q.cursor, undefined, undefined, q.placement);
  });
  app.post(`${ROOT}/conversations`, async (req, reply) => {
    const body = z
      .object({ title: Title.default("New conversation") })
      .strict()
      .parse(req.body ?? {});
    reply.code(201);
    return cloud.create(await mutation(req), body.title);
  });
  app.get(`${ROOT}/conversations/:id`, async (req) => {
    const query = z.object({ before: Id.optional() }).strict().parse(req.query);
    return cloud.detail(await actor(req), RunParams.parse(req.params).id, query.before);
  });
  app.patch(`${ROOT}/conversations/:id`, async (req) => {
    const body = z
      .object({ title: Title, expectedRevision: Revision })
      .strict()
      .parse(req.body);
    return cloud.rename(
      await mutation(req),
      RunParams.parse(req.params).id,
      body.title,
      body.expectedRevision,
    );
  });
  app.delete(`${ROOT}/conversations/:id`, async (req, reply) => {
    const body = z
      .object({ expectedRevision: z.coerce.number().int().positive() })
      .strict()
      .parse(req.query);
    await cloud.remove(
      await mutation(req),
      RunParams.parse(req.params).id,
      body.expectedRevision,
    );
    return reply.code(204).send();
  });
  app.post(`${ROOT}/conversations/:id/messages`, async (req, reply) => {
    const body = z
      .object({
        requestId: Id,
        text: Text,
        gatewayId: z.string().min(1).max(128),
        modelId: z.string().min(1).max(160),
        expectedRevision: Revision,
        attachmentIds: z.array(Id).max(20).optional(),
      })
      .strict()
      .parse(req.body);
    reply.code(202);
    return cloud.submit(
      await mutation(req),
      RunParams.parse(req.params).id,
      body,
    );
  });
  app.get(`${ROOT}/runs/:id`, async (req) =>
    cloud.snapshot(await actor(req), RunParams.parse(req.params).id),
  );
  app.post(`${ROOT}/runs/:id/cancel`, async (req) => {
    Empty.parse(req.body ?? {});
    return cloud.cancel(await mutation(req), RunParams.parse(req.params).id);
  });
  app.get(`${ROOT}/runs/:id/events`, async (req, reply) => {
    const q = z.object({ after: Cursor.optional() }).strict().parse(req.query);
    const last = req.headers["last-event-id"];
    let after = Cursor.parse(q.after ?? last ?? 0);
    const id = RunParams.parse(req.params).id;
    let a = await actor(req);
    await cloud.throttleRead(a.memberId);
    let batch = await cloud.events(a, id, after);
    streams.add(reply.raw);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-store, no-transform",
      "content-encoding": "identity",
      "x-accel-buffering": "no",
    });
    reply.raw.flushHeaders();
    let closed = false;
    const close = () => {
      closed = true;
    };
    reply.raw.once("close", close);
    const deadline = Date.now() + 60000;
    try {
      while (!closed && Date.now() < deadline) {
        for (const event of batch.events) {
          if (closed) break;
          const accepted = reply.raw.write(
            `id: ${event.sequence}\nevent: work\ndata: ${JSON.stringify(event)}\n\n`,
          );
          after = event.sequence;
          if (!accepted) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 2000);
              reply.raw.once("drain", () => {
                clearTimeout(timer);
                resolve();
              });
            });
            if (reply.raw.writableLength > 262144) {
              closed = true;
              break;
            }
          }
        }
        if (
          !["queued", "running", "awaitingApproval"].includes(
            batch.run.status,
          ) &&
          after >= batch.run.lastSequence
        )
          break;
        if (after < batch.run.lastSequence) {
          a = await actor(req);
          batch = await cloud.events(a, id, after);
          continue;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1000);
          timer.unref();
        });
        if (closed) break;
        a = await actor(req);
        batch = await cloud.events(a, id, after);
        if (!batch.events.length) reply.raw.write(": heartbeat\n\n");
      }
    } catch {
      if (!closed) reply.raw.write("event: access-revoked\ndata: {}\n\n");
    } finally {
      streams.delete(reply.raw);
      reply.raw.removeListener("close", close);
      reply.raw.end();
    }
  });
  app.post(`${INTERNAL}/claim`, async (req, reply) => {
    cloud.workerAuth(req.headers.authorization);
    const body = z
      .object({
        workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
        capabilities: z
          .object({
            projectScopes: z.boolean().optional(),
            tools: z.boolean(),
            files: z.boolean(),
            isolatedExecution: z.boolean(),
            documentPreviews: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(req.body);
    const claim = await cloud.claim(body.workerId, body.capabilities);
    return claim ?? reply.code(204).send();
  });
  const claims = (req: FastifyRequest) =>
    cloud.claims(req.headers.authorization, RunParams.parse(req.params).id);
  app.post(`${INTERNAL}/runs/:id/heartbeat`, async (req) => {
    Empty.parse(req.body ?? {});
    return cloud.heartbeat(claims(req));
  });
  app.post(`${INTERNAL}/runs/:id/events`, async (req) => {
    const body = z
      .object({
        requestId: Id,
        type: z.literal("assistant.delta"),
        data: z
          .object({
            text: z
              .string()
              .min(1)
              .max(16384)
              .refine((x) => Buffer.byteLength(x) <= 16384),
          })
          .strict(),
      })
      .strict()
      .parse(req.body);
    return cloud.delta(claims(req), body.requestId, body.data.text);
  });
  app.post(
    `${INTERNAL}/runs/:id/complete`,
    { bodyLimit: 8 * 1048576 },
    async (req) => {
      const body = z
        .object({
          text: z
            .string()
            .max(1048576)
            .refine((x) => Buffer.byteLength(x) <= 1048576),
          usage: z
            .object({
              inputTokens: z.number().int().min(0).max(1000000000),
              outputTokens: z.number().int().min(0).max(1000000000),
            })
            .strict()
            .optional(),
          finishReason: z.string().max(100).optional(),
        })
        .strict()
        .parse(req.body);
      return cloud.complete(claims(req), body);
    },
  );
  app.post(`${INTERNAL}/runs/:id/fail`, async (req) => {
    const body = z
      .object({
        code: z.literal("worker_failed"),
        usage: z
          .object({
            inputTokens: z.number().int().min(0).max(1000000000),
            outputTokens: z.number().int().min(0).max(1000000000),
          })
          .strict()
          .optional(),
        finishReason: z.string().max(100).optional(),
      })
      .strict()
      .parse(req.body);
    return cloud.fail(claims(req), body);
  });

  const UsageCounter = z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional();
  // Keep the HTTP validator exhaustive with the shared worker usage contract.
  const ReportedUsage = z
    .object({
      costMicrousd: UsageCounter,
      inputTokens: UsageCounter,
      outputTokens: UsageCounter,
      uncachedInputTokens: UsageCounter,
      cacheReadTokens: UsageCounter,
      cacheWriteTokens: UsageCounter,
      cacheWrite5mTokens: UsageCounter,
      cacheWrite1hTokens: UsageCounter,
      reasoningTokens: UsageCounter,
    } satisfies Record<keyof CloudReportedUsage, typeof UsageCounter>)
    .strict();
  const ToolCall = z
    .object({
      id: z.string().min(1).max(128),
      name: z.string().regex(/^[a-z_]{1,64}$/),
      arguments: z.record(z.string(), z.unknown()),
    })
    .strict()
    .refine((x) => Buffer.byteLength(JSON.stringify(x)) <= 128000);
  app.post(
    `${INTERNAL}/runs/:id/rounds/:roundId`,
    { bodyLimit: 1024 * 1024 },
    async (req) => {
      const p = z.object({ id: Id, roundId: Id }).strict().parse(req.params);
      const body = z
        .object({
          roundIndex: z.number().int().min(0).max(MAX_ROUNDS - 1),
          assistant: z
            .object({
              role: z.literal("assistant"),
              text: z.string().max(1048576),
              native: z.unknown().optional(),
            })
            .strict(),
          // The shared agent accepts up to 64 calls per turn. A valid parallel
          // batch must not fail admission merely because it has more than eight.
          toolCalls: z.array(ToolCall).max(64),
          usage: ReportedUsage.optional(),
          finishReason: z.string().max(100).optional(),
        })
        .strict()
        .parse(req.body);
      return cloud.rounds.receipt(
        cloud.claims(req.headers.authorization, p.id),
        p.roundId,
        body,
      );
    },
  );
  app.post(`${INTERNAL}/runs/:id/tools`, { bodyLimit: 256000 }, async (req) => {
    const body = z
      .object({ requestId: Id, roundId: Id, call: ToolCall })
      .strict()
      .parse(req.body);
    return cloud.tools.request(claims(req), body);
  });
  app.get(`${INTERNAL}/runs/:id/tools/:invocationId`, async (req) => {
    const p = z.object({ id: Id, invocationId: Id }).strict().parse(req.params);
    return cloud.tools.poll(
      cloud.claims(req.headers.authorization, p.id),
      p.invocationId,
    );
  });
  app.get(`${ROOT}/runs/:id/tools/:invocationId`, async (req) => {
    const p = z.object({ id: Id, invocationId: Id }).strict().parse(req.params);
    return cloud.tools.owned(await actor(req), p.id, p.invocationId);
  });
  app.post(`${ROOT}/runs/:id/approvals/:approvalId`, async (req) => {
    const p = z.object({ id: Id, approvalId: Id }).strict().parse(req.params);
    const body = z
      .object({
        requestId: Id,
        actionHash: z.string().regex(/^[a-f0-9]{64}$/),
        decision: z.enum(["approve", "deny"]),
      })
      .strict()
      .parse(req.body);
    return cloud.tools.decide(await mutation(req), p.id, p.approvalId, body);
  });
  app.post(
    `${INTERNAL}/runs/:id/provider`,
    { bodyLimit: 512000 },
    async (req, reply) => {
      const input = z
        .object({
          body: z.record(z.string(), z.unknown()),
          roundId: Id.optional(),
          roundIndex: z.number().int().min(0).max(MAX_ROUNDS - 1).optional(),
        })
        .strict()
        .refine(
          (x) => (x.roundId === undefined) === (x.roundIndex === undefined),
        )
        .parse(req.body);
      let body = input.body;
      let usageContext: CloudUsageContext | undefined;
      const claim = claims(req);
      const { run, target } = await cloud.provider(claim);
      const allowed = new Set([
        "model",
        "messages",
        "system",
        "max_tokens",
        "max_completion_tokens",
        "stream",
        "stream_options",
        "temperature",
        "top_p",
        "stop",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
      ]);
      if (
        Object.keys(body).some((k) => !allowed.has(k)) ||
        body.model !== run.model_id ||
        body.stream !== true
      )
        throw new IdentityError(
          400,
          "cloud_provider_request_invalid",
          "Cloud provider request is invalid.",
        );
      for (const k of ["max_tokens", "max_completion_tokens"])
        if (
          body[k] !== undefined &&
          (!Number.isInteger(body[k]) ||
            Number(body[k]) < 1 ||
            Number(body[k]) > MAX_RESPONSE_TOKENS)
        )
          throw new IdentityError(
            400,
            "cloud_provider_request_invalid",
            "Cloud output budget is invalid.",
          );
      // Only 0G's listing marks image and video models; all others always chat.
      const listing = target.providerId === "0g" ? await cachedWorkModels(target) : [];
      const media = listing.find(
        (model) => model.id === run.model_id && (model.category === "image" || model.category === "video"),
      );
      if (media) cloud.limits.prime(target, listing);
      if (input.roundId !== undefined) {
        let prepared;
        // Ask the provider for this model's real window first (cached, and never
        // inside the round's transaction); the round then plans against it.
        await cloud.limits.resolve(target, run.model_id).catch(() => undefined);
        const pricing = await resolveWorkPricing(target, run.model_id);
        try {
          prepared = await cloud.rounds.begin(
            claim,
            input.roundId,
            input.roundIndex!,
            body,
            pricing,
          );
        } catch (failure) {
          // Our own context budget refused the run before any provider call.
          // Recorded after the round's transaction has ended, so the run row is free.
          if (
            failure instanceof IdentityError &&
            failure.code === "cloud_context_full"
          )
            await cloud
              .recordProviderFailure(run.id, "provider_context_exceeded")
              .catch(() => {});
          throw failure;
        }
        body = prepared.body;
        usageContext = prepared.usageContext;
      } else {
        const limits = await cloud.limits.resolve(target, run.model_id);
        // Replace whatever the worker sent with the provider's accepted parameter.
        delete body.max_tokens;
        delete body.max_completion_tokens;
        // Stored server history is authoritative; workers cannot substitute arbitrary prompts.
        const history = await cloud.pool.query<{
          role: string;
          text: string;
        }>(
          "SELECT role,text FROM cloud_work_messages WHERE conversation_id=$1 ORDER BY created_at,id LIMIT 100",
          [run.conversation_id],
        );
        body.messages = history.rows.map((m) => ({
          role: m.role,
          content: m.text,
        }));
        // Plain chat has no tool surface; never forward worker-supplied tools upstream.
        delete body.tools;
        delete body.tool_choice;
        delete body.parallel_tool_calls;
        // The same resolver the tool-capable rounds use, so a filed chat never loses its project's context.
        const projectContext = await cloud.personalProjects.context.resolveForRun(run);
        const system =
          "You are Lori, a helpful assistant. Respond in plain Markdown. Tools and file access are unavailable in this Cloud chat.\n" +
          currentModelLine({
            id: run.model_id,
            providerName: providerGatewayDefinition(target.providerId).name,
            contextTokens: limits.contextTokens,
            outputTokens: limits.outputTokens,
          }) +
          `\n${PROMPT_PRIVACY}` +
          (projectContext ? `\n\n${projectContext}` : "");
        Object.assign(
          body,
          outputBudgetParams(
            target.protocol,
            target.providerId,
            limits.outputTokens,
          ),
        );
        if (target.protocol === "anthropic") {
          body.system = system;
          delete body.stream_options;
        } else {
          body.stream_options = { include_usage: true };
          body.messages = [
            { role: "system", content: system },
            ...(body.messages as unknown[]),
          ];
          delete body.system;
        }
        await cloud.provider(claim, true);
      }
      await cloud.throttleProvider(
        target.gatewayId,
        claim.memberId,
        target.requestsPerMinute,
      );
      const controller = new AbortController();
      controllers.add(controller);
      const cancel = () => controller.abort();
      reply.raw.once("close", cancel);
      req.raw.once("aborted", cancel);
      let checking = false;
      const recheck = setInterval(() => {
        if (checking || controller.signal.aborted) return;
        checking = true;
        const watchdog = setTimeout(cancel, 3000);
        watchdog.unref();
        void cloud
          .provider(claim)
          .catch(cancel)
          .finally(() => {
            clearTimeout(watchdog);
            checking = false;
          });
      }, 1000);
      recheck.unref();
      const cleanup = () => {
        controllers.delete(controller);
        clearInterval(recheck);
        controller.abort();
        reply.raw.removeListener("close", cancel);
        req.raw.removeListener("aborted", cancel);
      };
      const base = target.upstreamBaseUrl.replace(/\/+$/, "");
      const endpoint =
        target.protocol === "anthropic"
          ? `${base}${base.endsWith("/v1") ? "" : "/v1"}/messages`
          : `${base}${base.endsWith("/v1") || base.endsWith("/openai") ? "" : "/v1"}/chat/completions`;
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (target.protocol === "anthropic") {
        headers["anthropic-version"] = "2023-06-01";
        if (target.providerId === "anthropic")
          headers["x-api-key"] = target.apiKey;
        else headers.authorization = `Bearer ${target.apiKey}`;
      } else headers.authorization = `Bearer ${target.apiKey}`;
      try {
        if (media) {
          reply.header("content-type", "text/event-stream; charset=utf-8");
          const stream = mediaStream({
            cloud,
            claims: claim,
            target,
            model: media,
            prompt: mediaPrompt(body.messages),
            runId: run.id,
            signal: controller.signal,
            log: req.log,
          });
          stream.once("close", cleanup);
          return reply.send(stream);
        }
        const sendUpstream = (payload: Record<string, unknown>) =>
          fetch(endpoint, {
            method: "POST",
            body: JSON.stringify(payload),
            headers,
            redirect: "manual",
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(10 * 60 * 1000),
            ]),
          });
        const withTools = Array.isArray(body.tools) && body.tools.length > 0;
        const reasoningMatters = target.protocol === "openai" && withTools;
        const withKnownReasoning = (payload: Record<string, unknown>) =>
          reasoningMatters &&
          reasoningDisabledFor(target.providerId, run.model_id)
            ? withReasoningDisabled(payload)
            : payload;
        let response = await sendUpstream(withKnownReasoning(body));
        let refusal: string | undefined;
        if (!response.ok && response.body) {
          refusal = await readProviderRefusal(response);
          // A reply budget above the ceiling every provider accepts can be refused
          // by one upstream behind a gateway. Retry once within the limit it named,
          // before any byte has reached the member, and remember it for later turns.
          const sentOutput = Number(body.max_tokens ?? body.max_completion_tokens ?? 0);
          if (
            (response.status === 400 || response.status === 422) &&
            sentOutput > MAX_RESPONSE_TOKENS &&
            refusesOutputBudget(refusal) &&
            !mentionsContextOverflow(refusal)
          ) {
            const ceiling = outputCeilingFromRefusal(refusal, sentOutput);
            cloud.limits.learnOutput(target.providerId, run.model_id, ceiling, target);
            req.log.info(
              { providerId: target.providerId, modelId: run.model_id, outputTokens: ceiling },
              "Learned a lower reply limit from a provider refusal",
            );
            body = {
              ...body,
              ...outputBudgetParams(target.protocol, target.providerId, ceiling),
            };
            response = await sendUpstream(withKnownReasoning(body));
            refusal =
              !response.ok && response.body
                ? await readProviderRefusal(response)
                : undefined;
          }
          // Reasoning models refuse function tools with reasoning on Chat
          // Completions. Retry once with reasoning off, before any byte has
          // reached the member, and remember the model so later turns skip this.
          if (
            response.status === 400 &&
            reasoningMatters &&
            body.reasoning_effort === undefined &&
            rejectsReasoningWithTools(refusal ?? "")
          ) {
            rememberReasoningDisabled(target.providerId, run.model_id);
            req.log.info(
              { runId: run.id, providerId: target.providerId, modelId: run.model_id },
              "Retrying Cloud provider request with reasoning off for tool use",
            );
            response = await sendUpstream(withReasoningDisabled(body));
            refusal =
              !response.ok && response.body
                ? await readProviderRefusal(response)
                : undefined;
          }
          // The final step asks for a text-only answer with tool_choice "none".
          // A gateway that does not understand it gets one retry without it; the
          // system prompt already says tools are no longer available.
          if (
            !response.ok &&
            response.status === 400 &&
            body.tool_choice !== undefined &&
            /tool_choice/i.test(refusal ?? "")
          ) {
            const { tool_choice: _toolChoice, ...withoutChoice } = body;
            void _toolChoice;
            body = withoutChoice;
            response = await sendUpstream(body);
            refusal =
              !response.ok && response.body
                ? await readProviderRefusal(response)
                : undefined;
          }
        }
        if (!response.ok || !response.body) {
          // Classify (never store or log) the upstream body so the member and
          // administrator learn why, e.g. an unknown model or a rejected key.
          let mentionsModel = false;
          let contextExceeded = false;
          let fields: ReturnType<typeof upstreamErrorFields> = {};
          if (refusal) {
            mentionsModel = mentionsUnknownModel(refusal);
            contextExceeded = mentionsContextOverflow(refusal);
            fields = upstreamErrorFields(refusal);
            // The provider named its real window: plan against it from now on.
            if (contextExceeded) {
              const learned = cloud.limits.learn(target.providerId, run.model_id, refusal, target);
              if (learned)
                req.log.info(
                  { providerId: target.providerId, modelId: run.model_id, contextTokens: learned },
                  "Learned a lower context window from a provider refusal",
                );
            }
          }
          const cause = providerFailureFor(
            response.status,
            mentionsModel,
            contextExceeded,
          );
          req.log.warn(
            {
              runId: run.id,
              providerId: target.providerId,
              modelId: run.model_id,
              upstreamStatus: response.status,
              // Identifiers only; the provider's message text is never logged.
              upstreamError: fields,
              cause,
            },
            "Cloud provider request was refused",
          );
          await cloud.recordProviderFailure(run.id, cause);
          await response.body?.cancel().catch(() => {});
          throw new IdentityError(
            502,
            "cloud_provider_failed",
            "Company provider request failed.",
          );
        }
        const type = response.headers.get("content-type")?.split(";")[0];
        if (type !== "text/event-stream") {
          await response.body.cancel();
          throw new IdentityError(
            502,
            "cloud_provider_protocol",
            "Company provider did not return a stream.",
          );
        }
        reply.header("content-type", "text/event-stream; charset=utf-8");
        const source = Readable.fromWeb(response.body as never);
        const redacted = workCredentialRedactor(target.apiKey, {
          terminateEvents: true,
        });
        let bytes = 0;
        const bounded = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > 8 * 1048576) {
              callback(new Error("Cloud provider stream exceeded limit"));
              controller.abort();
            } else callback(null, chunk);
          },
        });
        source.once("error", () =>
          bounded.destroy(new Error("Cloud provider stream interrupted")),
        );
        redacted.once("error", () =>
          bounded.destroy(new Error("Cloud provider stream interrupted")),
        );
        bounded.once("close", () => {
          source.destroy();
          redacted.destroy();
          cleanup();
        });
        bounded.once("end", cleanup);
        bounded.once("error", cleanup);
        const observer = usageContext
          ? cloudUsageObserver(target.protocol, (usage) =>
              cloud.rounds.reportUsage(usageContext!, usage).then(() => {}),
            )
          : undefined;
        if (observer) {
          observer.once("error", () =>
            bounded.destroy(new Error("Cloud usage persistence failed")),
          );
          bounded.once("close", () => observer.destroy());
          source.pipe(observer).pipe(redacted).pipe(bounded);
        } else source.pipe(redacted).pipe(bounded);
        return reply.send(bounded);
      } catch (error) {
        // Read before cleanup(), which aborts the controller itself.
        const cancelled = controller.signal.aborted;
        cleanup();
        if (error instanceof IdentityError) throw error;
        // Network, DNS, TLS and timeout failures: the provider was unreachable.
        if (!cancelled) {
          req.log.warn(
            { runId: run.id, providerId: target.providerId },
            "Cloud provider was unreachable",
          );
          await cloud
            .recordProviderFailure(run.id, "provider_unavailable")
            .catch(() => {});
        }
        throw new IdentityError(
          502,
          "cloud_provider_failed",
          "Company provider request failed.",
        );
      }
    },
  );
  let maintaining = false;
  const maintenance = setInterval(() => {
    if (maintaining) return;
    maintaining = true;
    void cloud
      .maintain()
      .catch((e) =>
        app.log.error({ err: e }, "Cloud retention/recovery failed"),
      )
      .finally(() => {
        maintaining = false;
      });
  }, 15000);
  maintenance.unref();
  app.addHook("onClose", async () => {
    clearInterval(maintenance);
  });
}
