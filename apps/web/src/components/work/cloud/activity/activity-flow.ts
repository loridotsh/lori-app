import type { CloudToolInvocation } from "@lori-enterprise/contracts";
import { todoListFromOutput, type TodoList } from "@lori-enterprise/contracts";

export type FlowPart =
  | { type: "text"; key: string; text: string }
  | { type: "visual"; key: string; invocation: CloudToolInvocation }
  | { type: "todos"; key: string; list: TodoList }
  | { type: "tools"; key: string; invocations: CloudToolInvocation[] };

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/**
 * Lays a reply out in the order things happened: text, then the tool calls the
 * model made after it, then more text. Each call carries the reply length at
 * the moment it was made (`textOffset`).
 *
 * - Calls with no recorded offset (older runs) follow the previous call, or
 *   come first, so history from before offsets existed still reads sensibly.
 * - Calls with nothing but whitespace between them share one group.
 * - A slice never splits a surrogate pair, whatever offset arrives.
 */
export function buildFlow(
  text: string,
  invocations: CloudToolInvocation[],
): FlowPart[] {
  const ordered = [...invocations].sort(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  // A retry supersedes an obsolete failed visual with the same title, as in
  // Lori Desktop. Receipts stay durable; retain successes and the latest failure.
  const visualKey = (call: CloudToolInvocation) =>
    call.name === "present_visual" && typeof call.arguments?.title === "string" && call.arguments.title.trim()
      ? `${call.runId}:${call.arguments.title.trim()}` : undefined;
  const latestVisual = new Map<string, string>();
  for (const call of ordered) {
    const key = visualKey(call);
    if (key) latestVisual.set(key, call.id);
  }
  const parts: FlowPart[] = [];
  const todoUpdates = ordered.filter(call => call.name === "write_todos" && call.status === "completed" && todoListFromOutput(call.output));
  const latestTodos = todoUpdates.reduce<TodoList | null>((latest,call) => {
    const list = todoListFromOutput(call.output)!;
    return !latest || list.revision > latest.revision ? list : latest;
  },null);
  let cursor = 0;
  let group: CloudToolInvocation[] = [];
  const flushTools = () => {
    if (!group.length) return;
    parts.push({ type: "tools", key: `tools:${group[0]!.id}`, invocations: group });
    group = [];
  };
  const pushText = (from: number, to: number) => {
    const segment = text.slice(from, to);
    if (!segment.trim()) return;
    flushTools();
    parts.push({ type: "text", key: `text:${from}`, text: segment.trim() });
  };
  for (const call of ordered) {
    const key = visualKey(call);
    if (call.status === "failed" && key && latestVisual.get(key) !== call.id) continue;
    let offset =
      typeof call.textOffset === "number" && Number.isFinite(call.textOffset)
        ? Math.min(Math.max(Math.floor(call.textOffset), 0), text.length)
        : cursor;
    // Never go backwards, and never cut a character in half.
    offset = Math.max(offset, cursor);
    if (offset > 0 && offset < text.length && isHighSurrogate(text.charCodeAt(offset - 1)))
      offset += 1;
    if (offset > cursor) {
      pushText(cursor, offset);
      cursor = offset;
    }
    if (latestTodos && todoUpdates.some(update => update.id === call.id)) {
      if (call.id === todoUpdates[0]!.id) {
        flushTools();
        parts.push({ type:"todos",key:`todos:${call.id}`,list:latestTodos });
      }
    } else if (call.name === "read_todos" || call.name === "write_todos") {
      if (["failed", "interrupted", "outcomeUnknown", "rejected", "cancelled", "denied", "unknown"].includes(call.status) || call.status === "completed" && call.name === "write_todos") {
        flushTools();
        parts.push({ type: "text", key: `task-status:${call.id}`, text: call.name === "write_todos" ? "The task list update could not be confirmed." : "The saved task list could not be loaded." });
      }
    } else if (call.name === "update_task_progress" && call.status === "completed") {
      continue;
    } else if (call.name === "present_visual") {
      flushTools();
      parts.push({ type: "visual", key: `visual:${call.id}`, invocation: call });
    } else group.push(call);
  }
  flushTools();
  pushText(cursor, text.length);
  return parts;
}
