export type AttentionKind = "completed" | "failed" | "interrupted" | "approval";
export interface AttentionEvent { id: string; runId: string; conversationId: string; projectId: string | null; kind: AttentionKind; createdAt: string }
export interface AttentionPage { recipient: { organizationId: string; userId: string }; events: AttentionEvent[]; serverTime: string; nextCursor: string | null }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validTarget(value: unknown): value is { conversationId: string; projectId: string | null } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.conversationId === "string" && uuid.test(v.conversationId) && (v.projectId === null || typeof v.projectId === "string" && uuid.test(v.projectId));
}
export function parsePage(value: unknown): AttentionPage {
  const v = value as AttentionPage;
  if (!v || !v.recipient || typeof v.recipient.organizationId !== "string" || typeof v.recipient.userId !== "string" || !Array.isArray(v.events) || v.events.length > 100 || (typeof v.serverTime !== "string" || !Number.isFinite(Date.parse(v.serverTime))) || !(v.nextCursor === null || typeof v.nextCursor === "string" && /^[1-9][0-9]{0,18}$/.test(v.nextCursor)) || !v.events.every(e => validTarget(e) && typeof e.id === "string" && typeof e.runId === "string" && typeof e.createdAt === "string" && /^[1-9][0-9]{0,18}$/.test(e.id) && uuid.test(e.runId) && ["completed", "failed", "interrupted", "approval"].includes(e.kind) && Number.isFinite(Date.parse(e.createdAt)))) throw new Error("Work notifications could not be read. Update Lori or try again.");
  return v;
}
export function notificationCopy(kind: AttentionKind) {
  return kind === "approval" ? { title: "Work needs approval", body: "Open the conversation to review the request." }
    : kind === "completed" ? { title: "Work completed", body: "Your response is ready. Open the conversation to view it." }
    : { title: "Work needs attention", body: "A response could not finish. Open the conversation to review it." };
}
export function notificationPath(target: { conversationId: string; projectId: string | null }) {
  if (!validTarget(target)) throw new Error("Invalid Work conversation.");
  const query = new URLSearchParams({ conversation: target.conversationId });
  if (target.projectId) query.set("project", target.projectId);
  return `/work/cloud?${query}`;
}
