/** Enterprise Cloud is a separate, opt-in execution location. */
export const WORK_CLOUD_CONTRACT_VERSION = 1 as const;
export type CloudRunStatus =
  | "queued"
  | "running"
  | "awaitingApproval"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";
export interface CloudSettings {
  enabled: boolean;
  retentionDays: number;
  revision: number;
}
export type CloudApprovalMode = "askMe" | "approveForMe";
export interface CloudMemberPreferences {
  approvalMode: CloudApprovalMode;
  effectiveApprovalMode: CloudApprovalMode;
  forcedAskMe: boolean;
  revision: number;
}
export interface CloudProvider {
  gatewayId: string;
  providerId: string;
  name: string;
  modelIds: string[];
  /** Context window and per-reply output budget Cloud Work uses for each allowed model. */
  modelLimits?: Record<string, { contextTokens: number; outputTokens: number }>;
  /** Models that generate an image or a video from the prompt instead of chatting. */
  modelMedia?: Record<string, { kind: "image" | "video"; price?: string }>;
}
export interface CloudCapabilities {
  contractVersion: 1;
  enabled: boolean;
  available: boolean;
  providers: CloudProvider[];
  features: {
    chat: boolean;
    files: boolean;
    tools: boolean;
    extensions: boolean;
    memory: boolean;
    /** Older servers omit it; read a missing value as false. */
    personalProjects?: boolean;
  };
}
export interface CloudConversation {
  latestRunStatus?: CloudRunStatus | null;
  projectId?: string;
  /** The owner's personal project this private conversation is filed in. */
  personalProjectId?: string;
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface CloudMessage {
  author?: { memberId: string | null; name: string };
  attachments?: CloudFile[];
  runId: string;
  runStatus: CloudRunStatus;
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}
export interface CloudRun {
  projectId?: string;
  initiatedBy?: string;
  id: string;
  conversationId: string;
  status: CloudRunStatus;
  gatewayId: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
  lastSequence: number;
}
export interface CloudRunSnapshot {
  activityTruncated?: boolean;
  toolInvocations?: CloudToolInvocation[];
  approvals?: CloudApproval[];
  run: CloudRun;
  assistantText: string;
}
export interface CloudConversationDetail {
  /** Opaque, conversation-owned cursor for a complete earlier page. Missing on older servers. */
  historyCursor?: string | null;
  activityTruncated?: boolean;
  files?: CloudFile[];
  toolInvocations?: CloudToolInvocation[];
  approvals?: CloudApproval[];
  conversation: CloudConversation;
  messages: CloudMessage[];
  runs: CloudRun[];
}
export interface CloudConversationPage {
  conversations: CloudConversation[];
  nextCursor: string | null;
}
export interface CloudSendMessage {
  attachmentIds?: string[];
  requestId: string;
  text: string;
  gatewayId: string;
  modelId: string;
  expectedRevision: number;
}
export interface CloudSubmitResponse {
  conversation: CloudConversation;
  run: CloudRun;
}
export type CloudEventType =
  | "run.queued"
  | "run.started"
  | "assistant.delta"
  | "run.completed"
  | "run.cancelled"
  | "run.failed"
  | "run.interrupted"
  | "tool.requested"
  | "tool.completed"
  | "tool.failed"
  | "approval.requested"
  | "approval.decided"
  | "file.updated";
export interface CloudEvent {
  sequence: number;
  type: CloudEventType;
  data: {
    text?: string;
    code?: string;
    invocation?: CloudToolInvocation;
    approval?: CloudApproval;
    file?: CloudFile;
  };
  createdAt: string;
}
export interface CloudWorkerRun {
  tools?: CloudToolDefinition[];
  contextTokenLimit?: number;
  maxRounds?: number;
  id: string;
  conversationId: string;
  organizationId: string;
  memberId: string;
  gatewayId: string;
  modelId: string;
  providerId: string;
  protocol: "openai" | "anthropic";
  nativeOpenai: false;
  leaseId: string;
  leaseVersion: number;
  messages: {
    role: "user" | "assistant";
    text: string;
  }[];
  maxOutputTokens: number;
}
export interface CloudWorkerClaim {
  run: CloudWorkerRun;
  leaseToken: string;
}

export interface CloudFile {
  projectId?: string;
  id: string;
  conversationId: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface CloudToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface CloudToolInvocation {
  execution?: CloudExecution;
  id: string;
  runId: string;
  roundId: string;
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  actionHash: string;
  /** Length of the reply text when this call happened; places the call among the text. */
  textOffset?: number | null;
  status:
    | "pendingApproval"
    | "pendingExecution"
    | "running"
    | "completed"
    | "failed"
    | "denied"
    | "unknown";
  output?: unknown;
  createdAt: string;
  updatedAt: string;
}
export interface CloudApproval {
  decisionSource?: "user" | "automatic";
  kind?: "tool" | "apply_files";
  summary?: string;
  files?: {
    path: string;
    sha256: string;
    sizeBytes: number;
    expectedHash: string | null;
  }[];
  id: string;
  runId: string;
  invocationId: string;
  actionHash: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
}
export interface CloudToolResponse {
  invocationId: string;
  status:
    | "completed"
    | "failed"
    | "pendingApproval"
    | "pendingExecution"
    | "pendingRemote"
    | "unknown";
  output?: unknown;
}

export interface CloudExecution {
  kind: "python" | "document";
  operation: string;
  arguments: Record<string, unknown>;
  inputs: { path: string; fileId: string; sha256: string }[];
  outputs?: string[];
}

export interface CloudMemorySettings {
  enabled: boolean;
  revision: number;
  allowed: boolean;
}
export interface CloudMemoryNote {
  id: string;
  scope: "personal" | "conversation";
  conversationId: string | null;
  topic: string;
  content: string;
  sensitive: boolean;
  revision: number;
  provenance: "manual" | "approved_tool";
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Provider reports only. Null/omitted counters are unknown, never budget estimates. */
export interface CloudReportedUsage {
  /** Provider-reported USD cost, rounded to microdollars; absent is unknown. */
  costMicrousd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  uncachedInputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  cacheWrite5mTokens?: number | null;
  cacheWrite1hTokens?: number | null;
  reasoningTokens?: number | null;
}
