import { ClientApiError } from "./client-api";
import { workApi } from "./work-api";

import type {
  CloudCapabilities,
  CloudConversationDetail,
  CloudConversation,
  CloudConversationPage,
  CloudSubmitResponse,
  CloudSettings,
  CloudEvent,
  CloudRun,
  CloudRunSnapshot,
  CloudFile,
  CloudToolInvocation,
  CloudApproval,
} from "@lori-enterprise/contracts";
export type {
  CloudCapabilities,
  CloudConversation,
  CloudEvent,
  CloudMessage,
  CloudRun,
} from "@lori-enterprise/contracts";
export type CloudDetail = CloudConversationDetail;
export interface CloudStreamState {
  sequence: number;
  text: string;
}
export const cloudPath = "/v1/work/cloud";
const privateListing = /^\/conversations(?:\?(.*))?$/;
/** The Conversations group lists chats outside any personal project; the server default lists all of them. */
function placed(path: string, init?: RequestInit) {
  const match = privateListing.exec(path);
  if (!match || (init?.method ?? "GET") !== "GET") return path;
  const query = new URLSearchParams(match[1] ?? "");
  if (!query.has("placement")) query.set("placement", "unfiled");
  return `/conversations?${query}`;
}
export const cloudApi = <T>(path: string, init?: RequestInit) =>
  workApi<T>(`${cloudPath}${placed(path, init)}`, init);
export const cloudMutation = (body: unknown, method = "POST"): RequestInit => ({
  method,
  body: JSON.stringify(body),
});
export const isActiveRun = (run: CloudRun) =>
  run.status === "queued" ||
  run.status === "running" ||
  run.status === "awaitingApproval";

export function validateCloudCapabilities(
  value: CloudCapabilities,
): CloudCapabilities {
  if (
    !value ||
    typeof value.contractVersion !== "number" ||
    typeof value.enabled !== "boolean" ||
    typeof value.available !== "boolean" ||
    !Array.isArray(value.providers) ||
    !value.providers.every(
      (provider) =>
        !!provider &&
        typeof provider === "object" &&
        typeof provider.gatewayId === "string" &&
        typeof provider.name === "string" &&
        Array.isArray(provider.modelIds) &&
        provider.modelIds.every((id) => typeof id === "string"),
    ) ||
    !value.features ||
    !["chat", "files", "tools", "extensions", "memory"].every(
      (key) =>
        typeof value.features[key as keyof CloudCapabilities["features"]] ===
        "boolean",
    )
  ) {
    throw new ClientApiError(
      "invalid_response",
      "Cloud Work returned an unreadable response. Update Enterprise or try loading again.",
      502,
    );
  }
  return value;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const stringFields = (value: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => typeof value[key] === "string");
const validConversation = (value: unknown): value is CloudConversation =>
  object(value) &&
  stringFields(value, ["id", "title", "createdAt", "updatedAt"]) &&
  (value.latestRunStatus == null || runStatuses.includes(String(value.latestRunStatus))) &&
  Number.isSafeInteger(value.revision) &&
  Number(value.revision) > 0;
const runStatuses = [
  "queued",
  "running",
  "awaitingApproval",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
];
const validRun = (value: unknown): value is CloudRun =>
  object(value) &&
  stringFields(value, [
    "id",
    "conversationId",
    "gatewayId",
    "modelId",
    "createdAt",
    "updatedAt",
  ]) &&
  runStatuses.includes(String(value.status)) &&
  Number.isSafeInteger(value.lastSequence) &&
  Number(value.lastSequence) >= 0;
export const validCloudFile = (value: unknown): value is CloudFile =>
  object(value) &&
  stringFields(value, [
    "id",
    "conversationId",
    "path",
    "mimeType",
    "sha256",
    "createdAt",
    "updatedAt",
  ]) &&
  Number.isSafeInteger(value.sizeBytes) &&
  Number(value.sizeBytes) >= 0 &&
  Number.isSafeInteger(value.version) &&
  Number(value.version) > 0;
const validInvocation = (value: unknown): value is CloudToolInvocation =>
  object(value) &&
  stringFields(value, [
    "id",
    "runId",
    "roundId",
    "callId",
    "name",
    "actionHash",
    "createdAt",
    "updatedAt",
  ]) &&
  object(value.arguments) &&
  [
    "pendingApproval",
    "pendingExecution",
    "running",
    "completed",
    "failed",
    "denied",
    "unknown",
  ].includes(String(value.status)) &&
  (value.execution === undefined ||
    (object(value.execution) &&
      Array.isArray(value.execution.inputs) &&
      value.execution.inputs.every(
        (input) =>
          object(input) && stringFields(input, ["path", "fileId", "sha256"]),
      )));
const validApproval = (value: unknown): value is CloudApproval =>
  object(value) &&
  (value.decisionSource === undefined || ["user", "automatic"].includes(String(value.decisionSource))) &&
  stringFields(value, [
    "id",
    "runId",
    "invocationId",
    "actionHash",
    "createdAt",
  ]) &&
  ["pending", "approved", "denied", "expired"].includes(String(value.status)) &&
  (value.kind === undefined ||
    ["tool", "apply_files"].includes(String(value.kind))) &&
  (value.summary === undefined || typeof value.summary === "string") &&
  (value.files === undefined ||
    (Array.isArray(value.files) &&
      value.files.every(
        (file) =>
          object(file) &&
          stringFields(file, ["path", "sha256"]) &&
          Number.isSafeInteger(file.sizeBytes) &&
          Number(file.sizeBytes) >= 0 &&
          (file.expectedHash === null || typeof file.expectedHash === "string"),
      )));
const validTools = (value: CloudRunSnapshot | CloudConversationDetail) =>
  (value.toolInvocations === undefined ||
    (Array.isArray(value.toolInvocations) &&
      value.toolInvocations.every(validInvocation))) &&
  (value.approvals === undefined ||
    (Array.isArray(value.approvals) && value.approvals.every(validApproval)));
const unreadable = () =>
  new ClientApiError(
    "invalid_response",
    "Cloud Work returned an unreadable response. Update Enterprise or try loading again.",
    502,
  );
export function validateCloudSettings(value: unknown): CloudSettings {
  if (
    !object(value) ||
    typeof value.enabled !== "boolean" ||
    !Number.isSafeInteger(value.retentionDays) ||
    Number(value.retentionDays) < 1 ||
    Number(value.retentionDays) > 365 ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1
  )
    throw unreadable();
  return value as unknown as CloudSettings;
}
export function validateCloudConversation(value: unknown): CloudConversation {
  if (!validConversation(value)) throw unreadable();
  return value;
}
export function validateCloudConversationPage(value: unknown): CloudConversationPage {
  if (
    !object(value) ||
    !Array.isArray(value.conversations) ||
    !value.conversations.every(validConversation) ||
    !(value.nextCursor === null || typeof value.nextCursor === "string")
  )
    throw unreadable();
  return value as unknown as CloudConversationPage;
}
export function validateCloudSubmitResponse(value: unknown): CloudSubmitResponse {
  if (
    !object(value) ||
    !validConversation(value.conversation) ||
    !validRun(value.run) ||
    value.run.conversationId !== value.conversation.id
  )
    throw unreadable();
  return value as unknown as CloudSubmitResponse;
}
export function validateCloudFile(value: unknown): CloudFile {
  if (!validCloudFile(value)) throw unreadable();
  return value;
}
export function validateCloudDetail(
  value: CloudConversationDetail,
): CloudConversationDetail {
  if (
    !object(value) ||
    (value.historyCursor !== undefined && value.historyCursor !== null &&
      (typeof value.historyCursor !== "string" || !/^[a-f0-9-]{36}$/i.test(value.historyCursor))) ||
    !validConversation(value.conversation) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(
      (message) =>
        object(message) &&
        stringFields(message, ["id", "runId", "text", "createdAt"]) &&
        ["user", "assistant"].includes(String(message.role)) &&
        runStatuses.includes(String(message.runStatus)) &&
        (message.attachments === undefined ||
          (Array.isArray(message.attachments) &&
            message.attachments.every(validCloudFile))),
    ) ||
    !Array.isArray(value.runs) ||
    !value.runs.every(validRun) ||
    !validTools(value) ||
    (value.files !== undefined &&
      (!Array.isArray(value.files) || !value.files.every(validCloudFile)))
  )
    throw unreadable();
  return value;
}
export function validateCloudSnapshot(
  value: CloudRunSnapshot,
): CloudRunSnapshot {
  if (
    !object(value) ||
    !validRun(value.run) ||
    typeof value.assistantText !== "string" ||
    !validTools(value)
  )
    throw unreadable();
  return value;
}

/** Sequence IDs, rather than message text, make replay safe even for identical deltas. */
export function applyCloudEvent(
  state: CloudStreamState,
  event: CloudEvent,
): CloudStreamState {
  if (event.sequence <= state.sequence) return state;
  if (event.sequence !== state.sequence + 1) throw new Error("stream_gap");
  return {
    sequence: event.sequence,
    text:
      state.text +
      (event.type === "assistant.delta" ? (event.data.text ?? "") : ""),
  };
}

export function parseCloudEvent(frame: string): CloudEvent | null {
  const lines = frame.split("\n");
  if (!lines.some((line) => line === "event: work")) return null;
  const value: unknown = JSON.parse(
    lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n"),
  );
  if (!value || typeof value !== "object") throw new Error("invalid_event");
  const event = value as CloudEvent;
  if (
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    ![
      "run.queued",
      "run.started",
      "assistant.delta",
      "run.completed",
      "run.cancelled",
      "run.failed",
      "run.interrupted",
      "tool.requested",
      "tool.completed",
      "tool.failed",
      "approval.requested",
      "approval.decided",
      "file.updated",
    ].includes(event.type) ||
    !event.data ||
    typeof event.data !== "object" ||
    (event.data.text !== undefined && typeof event.data.text !== "string") ||
    (event.data.invocation !== undefined &&
      !validInvocation(event.data.invocation)) ||
    (event.data.approval !== undefined &&
      !validApproval(event.data.approval)) ||
    (event.data.file !== undefined && !validCloudFile(event.data.file))
  )
    throw new Error("invalid_event");
  return event;
}

export const CLOUD_STREAM_IDLE_TIMEOUT_MS = 10_000;
export const CLOUD_STREAM_SNAPSHOT_INTERVAL_MS = 15_000;

/** Each bounded connection recovers via an authoritative snapshot, even if a proxy delivers only heartbeats. */
export async function readCloudEvents(
  runId: string,
  after: number,
  signal: AbortSignal,
  onEvent: (event: CloudEvent) => void,
  projectId?: string,
) {
  const watchdog = new AbortController();
  const streamSignal = AbortSignal.any([signal, watchdog.signal]);
  let idle: ReturnType<typeof setTimeout>;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => watchdog.abort(), CLOUD_STREAM_IDLE_TIMEOUT_MS);
  };
  resetIdle();
  const snapshotDeadline = setTimeout(
    () => watchdog.abort(),
    CLOUD_STREAM_SNAPSHOT_INTERVAL_MS,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let removeAbort = () => {};
  try {
    const response = await fetch(
      `/api${cloudPath}/runs/${encodeURIComponent(runId)}/events?after=${after}`,
      {
        credentials: "same-origin",
        headers: { Accept: "text/event-stream", ...(projectId ? { "x-lori-project-id": projectId } : {}) },
        signal: streamSignal,
        cache: "no-store",
      },
    );
    if (!response.ok) {
      // Preserve the refusal code (work_disabled, session ended, …) when given.
      let code = "stream_unavailable";
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === "string" && /^[a-z][a-z_]{0,63}$/.test(body.error))
          code = body.error;
      } catch {
        // Not JSON: keep the generic code.
      }
      await response.body?.cancel().catch(() => {});
      throw new ClientApiError(
        code,
        "Live updates could not be connected.",
        response.status,
      );
    }
    if (
      !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    )
      throw new Error("invalid_stream");
    reader = response.body.getReader();
    const aborted = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new Error("stream_aborted"));
      streamSignal.addEventListener("abort", abort, { once: true });
      removeAbort = () => streamSignal.removeEventListener("abort", abort);
      if (streamSignal.aborted) abort();
    });
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      resetIdle();
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      if (buffer.length > 1_048_576) throw new Error("stream_frame_too_large");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const event = parseCloudEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (event) onEvent(event);
      }
    }
  } catch (failure) {
    if (watchdog.signal.aborted && !signal.aborted)
      throw new ClientApiError(
        "stream_snapshot_refresh",
        "Checking the latest saved response.",
        0,
      );
    throw failure;
  } finally {
    clearTimeout(idle!);
    clearTimeout(snapshotDeadline);
    removeAbort();
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export type CloudRunProblem = {
  tone: "error" | "notice";
  /** A deliberate stop needs only a quiet inline status, not a recovery card. */
  compact?: boolean;
  title: string;
  detail: string;
  /** Whether sending the same message again can plausibly help. */
  retry: boolean;
  /** Where the member can go to fix it, when it is not a plain retry. */
  fix?: "models" | "administrator" | "access" | "newConversation";
};

/** 1_050_000 → "1.05M", 128_000 → "128K": short enough for a chip or menu row. */
/** A new conversation starts on a chat model; image and video models are a deliberate choice. */
export const defaultModelId = (provider?: CloudCapabilities["providers"][number]): string =>
  provider?.modelIds.find((id) => !provider.modelMedia?.[id]) ?? provider?.modelIds[0] ?? "";

export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "";
  if (tokens >= 1_000_000)
    return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(Math.round(tokens));
}

/** Plain-language explanation for a run that did not complete, or null when nothing went wrong. */
export function cloudRunProblem(
  status: string,
  errorCode?: string | null,
): CloudRunProblem | null {
  const saved = "Your conversation is saved.";
  if (status === "cancelled") {
    if (errorCode === "policy_revoked" || errorCode === "cloud_disabled")
      return {
        tone: "notice",
        title: "Stopped by your organization",
        detail: `Your administrator changed Work access while this response was running. ${saved}`,
        retry: false,
        fix: "access",
      };
    if (errorCode === "membership_revoked")
      return {
        tone: "notice",
        title: "Access ended",
        detail: "Your access to this organization ended, so the response was stopped.",
        retry: false,
      };
    return {
      tone: "notice",
      title: "Response stopped",
      compact: true,
      detail: "You can send another message whenever you are ready.",
      retry: true,
    };
  }
  if (status === "interrupted")
    return {
      tone: "error",
      title: "The response was interrupted",
      detail: `The worker stopped before the answer finished. ${saved} Try again to get a complete response.`,
      retry: true,
    };
  if (status !== "failed") return null;
  switch (errorCode) {
    case "provider_auth_failed":
      return {
        tone: "error",
        title: "The company provider rejected its credentials",
        detail: `The API key your organization connected for this provider was refused. An administrator needs to update it. ${saved}`,
        retry: false,
        fix: "administrator",
      };
    case "provider_model_unavailable":
      return {
        tone: "error",
        title: "This model is not available",
        detail: `The provider does not recognize the selected model. Pick a different model, or ask an administrator to correct the allowed model list. ${saved}`,
        retry: false,
        fix: "models",
      };
    case "provider_rate_limited":
      return {
        tone: "error",
        title: "The provider is rate limiting requests",
        detail: `Too many requests were sent to the provider. Wait a moment and try again. ${saved}`,
        retry: true,
      };
    case "provider_unavailable":
      return {
        tone: "error",
        title: "The provider is unavailable",
        detail: `The company provider could not be reached or had an outage. ${saved} Try again shortly.`,
        retry: true,
      };
    case "provider_context_exceeded":
      return {
        tone: "error",
        title: "This conversation is too long for the model",
        detail: `The conversation and files have grown past what this model can read at once. ${saved} Start a new conversation, or choose a model with a larger context window.`,
        retry: false,
        fix: "newConversation",
      };
    case "model_tool_call_invalid":
      return {
        tone: "error",
        title: "The model sent an invalid tool request",
        detail: `The model asked for a tool that does not exist or sent a request that could not be read, so the response could not continue. ${saved} Try again, or choose another model.`,
        retry: true,
        fix: "models",
      };
    case "provider_request_rejected":
      return {
        tone: "error",
        title: "The provider rejected this request",
        detail: `The provider refused the request itself, which usually means a setting this model does not accept. ${saved} Try a different model, or ask an administrator to check the provider's configuration.`,
        retry: false,
        fix: "models",
      };
    default:
      return {
        tone: "error",
        title: "The response could not be completed",
        detail: `Something went wrong while generating this answer. ${saved} Try again, or choose another model.`,
        retry: true,
        fix: "models",
      };
  }
}

export function cloudError(error: unknown): string {
  if (error instanceof ClientApiError) {
    if (error.status === 401)
      return "Your session ended. Sign in again to continue.";
    if (error.status === 403) {
      if (error.code === "cloud_disabled")
        return "Cloud Work is not set up on this server yet: its worker is not configured. Ask an administrator to configure the Cloud Work worker.";
      if (error.code === "admin_required")
        return "Only an administrator can change this setting.";
      if (error.code === "work_disabled")
        return "Your organization has disabled Work for your account. Ask an administrator to review your Work access.";
      if (error.code === "cloud_memory_disabled")
        return "Cloud Work memory is disabled by your organization’s policy.";
      if (error.code === "cloud_model_denied")
        return "This model is not available here. In a shared project only the project's assigned models can be used. Load Cloud Work again to choose an available model.";
      // These carry a specific, actionable server explanation.
      if (["project_resource_not_approved", "delegation_not_approved", "owner_required", "cloud_provider_denied", "cloud_extension_policy_denied", "session_not_fresh"].includes(error.code))
        return error.message;
      return "Your organization has not granted you Cloud Work access.";
    }
    if (error.status === 404 && error.code.startsWith("project_"))
      return "This project is unavailable or you do not have access.";
    if (error.status === 404 && !error.code.startsWith("cloud_"))
      return "Cloud Work requires an Enterprise server update.";
    if (error.status === 409 && error.code === "project_policy_upgrade_required")
      return error.message;
    if (error.status === 409 && error.code === "cloud_revision_conflict")
      return "This conversation changed. Load the latest conversation before continuing.";
    return error.message;
  }
  return "Cloud Work could not be reached. Try loading again.";
}
