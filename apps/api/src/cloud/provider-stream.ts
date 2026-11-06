/**
 * Repairs a provider's event stream on its way to the worker, and keeps the
 * connection alive while the model is silent.
 *
 * Some gateways repeat a tool call's ID in a later chunk. The worker's parser
 * follows the streaming contract and joins ID fragments, so a repeat doubles the
 * ID and a provider later refuses it as too long. A model can also think for
 * minutes without sending a byte, which the worker reads as a dead connection.
 */
import { Transform } from "node:stream";

const NEWLINE = 10;
/** A line this long is passed along untouched rather than buffered without end. */
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const KEEP_ALIVE_MS = 30_000;
/** The same patience the worker gives a provider's first byte. */
const STALLED_MS = 10 * 60 * 1000;
const COMMENT = Buffer.from(": keep-alive\n\n");

/** Removes an ID already seen for its call, returning the line unchanged when nothing repeats. */
export function withoutRepeatedCallId(line: string, seen: Map<string, string>): string {
  if (!line.startsWith("data:") || !line.includes('"tool_calls"')) return line;
  let frame: { choices?: { delta?: { tool_calls?: unknown } }[] } | null;
  try {
    frame = JSON.parse(line.slice(5));
  } catch {
    return line;
  }
  const calls = frame?.choices?.[0]?.delta?.tool_calls;
  if (!Array.isArray(calls)) return line;
  let changed = false;
  for (const call of calls as { index?: unknown; id?: unknown }[]) {
    if (typeof call?.id !== "string" || !call.id) continue;
    const index = String(call.index);
    const known = seen.get(index) ?? "";
    if (call.id === known) {
      delete call.id;
      changed = true;
    } else seen.set(index, known + call.id);
  }
  if (!changed) return line;
  return `data: ${JSON.stringify(frame)}${line.endsWith("\r") ? "\r" : ""}`;
}

export function providerStreamRepair({
  onStalled,
  keepAliveMs = KEEP_ALIVE_MS,
  stalledMs = STALLED_MS,
  now = Date.now,
}: {
  onStalled: () => void;
  keepAliveMs?: number;
  stalledMs?: number;
  now?: () => number;
}): Transform {
  const seen = new Map<string, string>();
  let pending: Buffer = Buffer.alloc(0);
  let tail: Buffer = Buffer.alloc(0);
  let last = now();
  const sent =(output: Buffer) => {
    if (output.length) tail = Buffer.from(Buffer.concat([tail, output]).subarray(-4));
    return output;
  };
  // A comment is only safe between events: inside one it would end the event early.
  const betweenEvents = () => {
    const text = tail.toString("latin1");
    return !pending.length && (text.endsWith("\n\n") || text.endsWith("\r\n\r\n"));
  };
  const repaired = (lines: Buffer) => {
    const text = lines.toString("utf8");
    if (!text.includes('"tool_calls"')) return lines;
    return Buffer.from(text.split("\n").map((line) => withoutRepeatedCallId(line, seen)).join("\n"));
  };
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      last = now();
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const end = pending.lastIndexOf(NEWLINE);
      if (end < 0) {
        if (pending.length <= MAX_LINE_BYTES) return callback();
        const output = pending;
        pending = Buffer.alloc(0);
        return callback(null, sent(output));
      }
      const lines = pending.subarray(0, end + 1);
      pending = Buffer.from(pending.subarray(end + 1));
      callback(null, sent(repaired(lines)));
    },
    flush(callback) {
      clearInterval(timer);
      callback(null, pending.length ? sent(repaired(pending)) : undefined);
    },
    destroy(error, callback) {
      clearInterval(timer);
      callback(error);
    },
  });
  const timer = setInterval(() => {
    const silent = now() - last;
    if (silent >= stalledMs) {
      clearInterval(timer);
      onStalled();
    } else if (silent >= keepAliveMs && betweenEvents()) stream.push(sent(COMMENT));
  }, keepAliveMs);
  timer.unref();
  return stream;
}
