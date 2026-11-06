/**
 * Image and video generation for 0G's media models.
 *
 * A media model is chosen like any chat model and runs through the same lease,
 * round and cancellation path. Only the provider call differs: this answers the
 * worker with an ordinary one-message stream, so the worker is unchanged. 0G
 * keeps a finished clip for a limited time, so the bytes are saved in the
 * conversation's files before the reply is sent.
 */
import { randomUUID } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import type { FastifyBaseLogger } from "fastify";
import type { WorkDiscoveredModel } from "../auth/work-model-discovery.js";
import { MAX_GENERATED_FILE } from "./files.js";
import type { LimitTarget } from "./model-limit-discovery.js";
import { readProviderRefusal } from "./provider-refusal.js";
import {
  mentionsUnknownModel,
  providerFailureFor,
  upstreamErrorFields,
  type CloudWorkService,
  type ProviderFailure,
} from "./service.js";
import type { LeaseClaims } from "./security.js";

const IMAGE_TIMEOUT_MS = 5 * 60 * 1000;
/** Inside the worker's 15-minute run budget, so a slow clip fails with a clear reason. */
const VIDEO_DEADLINE_MS = 13 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 60_000;
const KEEP_ALIVE_MS = 15_000;
const MAX_IMAGE_RESPONSE_BYTES = 64 * 1024 * 1024;

class MediaFailure extends Error {
  constructor(
    readonly failure: ProviderFailure,
    readonly status: number,
    readonly fields: ReturnType<typeof upstreamErrorFields> = {},
  ) {
    super("Media generation failed");
  }
}

async function refused(response: Response): Promise<MediaFailure> {
  const refusal = await readProviderRefusal(response);
  return new MediaFailure(
    providerFailureFor(response.status, mentionsUnknownModel(refusal)),
    response.status,
    upstreamErrorFields(refusal),
  );
}

/** The newest member message, which is the prompt. History is not sent to media models. */
export function mediaPrompt(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const latest = [...messages].reverse().find((message) => message?.role === "user");
  const content: unknown = latest?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => (typeof part?.text === "string" ? [part.text as string] : []))
    .join("\n")
    .trim();
}

async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new MediaFailure("provider_unavailable", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new MediaFailure("provider_request_rejected", 413);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, size);
}

interface Generated {
  bytes: Buffer;
  mime: string;
  extension: string;
}

function imageFormat(bytes: Buffer): Pick<Generated, "mime" | "extension"> {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { mime: "image/jpeg", extension: "jpg" };
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP")
    return { mime: "image/webp", extension: "webp" };
  return { mime: "image/png", extension: "png" };
}

function videoFormat(bytes: Buffer): Pick<Generated, "mime" | "extension"> {
  return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    ? { mime: "video/webm", extension: "webm" }
    : { mime: "video/mp4", extension: "mp4" };
}

interface Generation {
  base: string;
  headers: Record<string, string>;
  model: WorkDiscoveredModel;
  prompt: string;
  signal: AbortSignal;
}

async function generateImage({ base, headers, model, prompt, signal }: Generation): Promise<Generated> {
  const response = await fetch(`${base}/images/generations`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ model: model.id, prompt, n: 1, response_format: "b64_json" }),
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)]),
  });
  if (!response.ok) throw await refused(response);
  const body = JSON.parse((await boundedBytes(response, MAX_IMAGE_RESPONSE_BYTES)).toString("utf8")) as {
    data?: { b64_json?: unknown }[];
  };
  const encoded = body.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || !encoded) throw new MediaFailure("provider_unavailable", 502);
  const bytes = Buffer.from(encoded, "base64");
  return { bytes, ...imageFormat(bytes) };
}

/** 0G's documentation shows `seconds` both as a number and as a string, so a refused number is resent as text. */
async function submitVideo({ base, headers, model, prompt, signal }: Generation): Promise<string> {
  const seconds = model.videoSeconds ?? 5;
  let response: Response | undefined;
  for (const value of [seconds, String(seconds)]) {
    response = await fetch(`${base}/videos`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model: model.id, prompt, seconds: value }),
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (response.status !== 400) break;
    if (typeof value === "number") await response.body?.cancel().catch(() => undefined);
  }
  if (!response?.ok) throw await refused(response!);
  const job = (await response.json()) as { id?: unknown };
  if (typeof job.id !== "string" || !job.id || job.id.length > 256) throw new MediaFailure("provider_unavailable", 502);
  return job.id;
}

async function generateVideo(generation: Generation): Promise<Generated> {
  const { base, headers, signal } = generation;
  const id = await submitVideo(generation);
  const job = `${base}/videos/${encodeURIComponent(id)}`;
  const deadline = Date.now() + VIDEO_DEADLINE_MS;
  while (true) {
    signal.throwIfAborted();
    if (Date.now() > deadline) throw new MediaFailure("provider_unavailable", 504);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS).unref());
    const poll = await fetch(job, {
      headers,
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    }).catch((error: unknown) => {
      if (signal.aborted) throw error;
      return null; // One lost poll is not a lost clip.
    });
    if (!poll || poll.status === 429 || poll.status >= 500) {
      await poll?.body?.cancel().catch(() => undefined);
      continue;
    }
    if (!poll.ok) throw await refused(poll);
    const status = ((await poll.json()) as { status?: unknown }).status;
    if (status === "failed") throw new MediaFailure("provider_request_rejected", 424);
    if (status === "completed") break;
  }
  const content = await fetch(`${job}/content`, {
    headers,
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(VIDEO_DEADLINE_MS)]),
  });
  if (!content.ok) throw await refused(content);
  const bytes = await boundedBytes(content, MAX_GENERATED_FILE);
  return { bytes, ...videoFormat(bytes) };
}

/** A readable file name from the prompt, unique so a repeat never conflicts. */
export function mediaPath(prompt: string, kind: "image" | "video", extension: string): string {
  const slug = prompt
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return `generated/${slug || kind}-${randomUUID().slice(0, 8)}.${extension}`;
}

const frame = (model: string, delta: object, finish: string | null) =>
  `data: ${JSON.stringify({ id: "lori-media", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usage = (model: string) =>
  `data: ${JSON.stringify({ id: "lori-media", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\n`;

export function mediaStream(input: {
  cloud: CloudWorkService;
  claims: LeaseClaims;
  target: LimitTarget;
  model: WorkDiscoveredModel;
  prompt: string;
  runId: string;
  signal: AbortSignal;
  log: FastifyBaseLogger;
}): Readable {
  const { cloud, claims, target, model, prompt, runId, signal, log } = input;
  const kind = model.category === "video" ? "video" : "image";
  const out = new PassThrough();
  // A failure is recorded on the run; this only keeps a cancelled stream from throwing.
  out.on("error", () => undefined);
  // A comment reaches the worker at once; the clip itself can take minutes.
  out.write(": generating\n\n");
  const keepAlive = setInterval(() => out.write(": generating\n\n"), KEEP_ALIVE_MS);
  keepAlive.unref();
  void (async () => {
    try {
      if (!prompt) throw new MediaFailure("provider_request_rejected", 400);
      out.write(frame(model.id, { role: "assistant", content: `Generating your ${kind} with ${model.name}.\n\n` }, null));
      const generation: Generation = {
        base: target.upstreamBaseUrl.replace(/\/+$/, ""),
        headers: { authorization: `Bearer ${target.apiKey}` },
        model,
        prompt,
        signal,
      };
      const media = await (kind === "video" ? generateVideo(generation) : generateImage(generation));
      if (!media.bytes.length) throw new MediaFailure("provider_unavailable", 502);
      const path = mediaPath(prompt, kind, media.extension);
      await cloud.transaction(async (c) => {
        const { r } = await cloud.lease(c, claims);
        const member = await c.query<{ user_id: string }>('SELECT "userId" AS user_id FROM member WHERE id=$1', [r.member_id]);
        const file = await cloud.files.saveTx(
          c,
          {
            ...(r.project_id ? { projectId: r.project_id } : {}),
            organizationId: r.organization_id,
            memberId: r.member_id,
            userId: member.rows[0]!.user_id,
            role: "member",
          },
          r.conversation_id,
          path,
          media.bytes,
          media.mime,
          undefined,
          undefined,
          true,
        );
        await cloud.event(c, r, "file.updated", { file });
      });
      out.write(frame(model.id, { content: `[${path.split("/").at(-1)!}](${path})` }, null));
      out.write(frame(model.id, {}, "stop"));
      out.write(usage(model.id));
      out.end("data: [DONE]\n\n");
    } catch (error) {
      if (!signal.aborted) {
        const failure = error instanceof MediaFailure ? error : new MediaFailure("provider_unavailable", 0);
        log.warn(
          { runId, providerId: target.providerId, modelId: model.id, upstreamStatus: failure.status, upstreamError: failure.fields, cause: failure.failure },
          "Cloud media generation failed",
        );
        await cloud.recordProviderFailure(runId, failure.failure).catch(() => undefined);
      }
      out.destroy(new Error("Cloud media generation failed"));
    } finally {
      clearInterval(keepAlive);
    }
  })();
  return out;
}
