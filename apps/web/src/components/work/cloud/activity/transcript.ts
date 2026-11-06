import type { CloudMessage, CloudRun, CloudToolInvocation } from "@lori-enterprise/contracts";

export type TranscriptEntry =
  | { type: "user"; key: string; message: CloudMessage }
  | { type: "response"; key: string; runId: string; text: string; active: boolean };

/** A streamed response and its eventual durable message share one React identity.
 * This preserves local exploration controls through terminal reconciliation.
 */
export function buildTranscript(messages: CloudMessage[], invocations: CloudToolInvocation[], activeRun?: CloudRun, streamText = ""): TranscriptEntry[] {
  const replies = new Map(messages.filter(m => m.role === "assistant").map(m => [m.runId, m]));
  const withTools = new Set(invocations.map(i => i.runId));
  const emitted = new Set<string>();
  const entries: TranscriptEntry[] = [];
  const response = (runId: string) => {
    if (emitted.has(runId)) return;
    const reply = replies.get(runId);
    const active = activeRun?.id === runId;
    if (!reply && !withTools.has(runId) && !active) return;
    emitted.add(runId);
    entries.push({ type: "response", key: `response:${runId}`, runId, text: active ? streamText : reply?.text ?? "", active });
  };
  for (const message of messages) {
    if (message.role === "user") entries.push({ type: "user", key: `user:${message.id}`, message });
    response(message.runId);
  }
  if (activeRun) response(activeRun.id);
  return entries;
}
