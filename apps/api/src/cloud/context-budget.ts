/**
 * Builds the conversation a model sees each round, and shrinks it step by step
 * when it would not fit the model's context window.
 *
 * Failing a run because history grew is the worst answer: the member loses the
 * response and the work in flight. Agent harnesses instead keep the newest
 * material verbatim and compact the oldest first: stale tool results become
 * short receipts (the full output stays on the server, readable with
 * read_tool_output), old screenshots are dropped, long older messages are
 * shortened, and only then are the oldest turns dropped. The member's latest
 * message and the most recent tool results are never compacted.
 */
import { imageMessage, renderedPageMessages } from "./continuation.js";
import { modelOutput } from "./tools.js";

export interface Compaction {
  /** Bytes kept of each tool result from the last three rounds. */
  latestResult: number;
  /** Bytes kept of every older tool result. */
  olderResult: number;
  /** Image results are delivered only from this many latest rounds. */
  imageRounds: number;
  /** Older messages (all but the newest few) are cut to this many characters. */
  oldMessageChars: number;
  /** Most conversation messages kept, newest first. */
  keepMessages: number;
}

/** From full detail to the smallest history that still carries the conversation. */
export const COMPACTION_LEVELS: readonly Compaction[] = [
  { latestResult: 8192, olderResult: 2048, imageRounds: 2, oldMessageChars: Infinity, keepMessages: 200 },
  { latestResult: 4096, olderResult: 1024, imageRounds: 1, oldMessageChars: 12_000, keepMessages: 60 },
  { latestResult: 2048, olderResult: 384, imageRounds: 1, oldMessageChars: 4_000, keepMessages: 24 },
  { latestResult: 1024, olderResult: 256, imageRounds: 0, oldMessageChars: 1_500, keepMessages: 10 },
  { latestResult: 512, olderResult: 192, imageRounds: 0, oldMessageChars: 600, keepMessages: 4 },
];

/** Messages this recent are never shortened. */
const RECENT_MESSAGES = 6;
/** Tool results from this many latest rounds count as recent. */
const RECENT_ROUNDS = 2;

export interface HistoryMessage {
  role: string;
  text: string;
  /** Workspace paths attached to the message. */
  attachments: string[];
}
export interface PriorCall {
  id: string;
  name: string;
  status: string;
  invocationId: string;
  /** What the model may read: the bounded receipt, or the raw output when none was stored. */
  output: unknown;
  /** The full output including image data; only loaded for the latest rounds. */
  rawOutput?: unknown;
}
export interface PriorRound {
  index: number;
  assistant: { text: string; native?: unknown };
  calls: PriorCall[];
}
export interface AssembleInput {
  protocol: "openai" | "anthropic";
  /** Index of the round about to start. */
  index: number;
  history: HistoryMessage[];
  rounds: PriorRound[];
  /** Notes placed before the conversation, in order (memory, uncertain receipts). */
  preface: string[];
}

/** Cuts without splitting a surrogate pair. */
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = /[\uD800-\uDBFF]/.test(text[max - 1] ?? "") ? max - 1 : max;
  return `${text.slice(0, cut)}\n…[shortened to fit the model's context window]`;
}

function conversation(input: AssembleInput, level: Compaction) {
  let kept = input.history.slice(-level.keepMessages);
  // A conversation must open with the member; never leave a reply with no question above it.
  while (kept.length > 1 && kept[0]!.role !== "user") kept = kept.slice(1);
  const omitted = input.history.length - kept.length;
  const messages: unknown[] = kept.map((message, position) => {
    const full =
      message.text +
      (message.attachments.length
        ? `\n\nAttached workspace files: ${message.attachments.join(", ")}`
        : "");
    const recent = position >= kept.length - RECENT_MESSAGES;
    return {
      role: message.role,
      content: recent ? full : shorten(full, level.oldMessageChars),
    };
  });
  if (omitted > 0)
    messages.unshift({
      role: "user",
      content: `[${omitted} earlier message${omitted === 1 ? "" : "s"} in this conversation were left out to fit the model's context window. Use read_conversation_history to recover needed evidence; this omission does not cancel earlier constraints.]`,
    });
  return messages;
}

/** The messages for one round at one compaction level. Pure: the same input always gives the same output. */
export function assembleMessages(input: AssembleInput, level: Compaction): unknown[] {
  const messages = conversation(input, level);
  const notes = input.preface.map((content) => ({ role: "user", content }));
  messages.unshift(...notes);
  for (const round of input.rounds) {
    const recent = input.index - round.index <= RECENT_ROUNDS;
    if (input.protocol === "openai")
      messages.push(round.assistant.native ?? { role: "assistant", content: round.assistant.text });
    else
      messages.push({
        role: "assistant",
        content: round.assistant.native ?? [{ type: "text", text: round.assistant.text }],
      });
    const images: NonNullable<ReturnType<typeof imageMessage>>[] = [];
    const results: unknown[] = [];
    for (const call of round.calls) {
      const preview = modelOutput(call.output, call.invocationId, recent ? level.latestResult : level.olderResult);
      // Native call IDs identify protocol pairs, not durable evidence. Always
      // expose the host-owned receipt ID, including for short results. Keep
      // invocationId untouched: paged outputs use it to identify their source.
      const text = JSON.stringify(preview && typeof preview === "object" && !Array.isArray(preview)
        ? { ...preview, receiptId: call.invocationId }
        : { result: preview, receiptId: call.invocationId });
      if (input.protocol === "openai")
        messages.push({ role: "tool", tool_call_id: call.id, content: text });
      else
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: text,
          is_error: call.status !== "completed",
        });
      // Only successful view_image receipts deliver images, and only from the
      // newest rounds. Never interleave an image between the tool results of
      // one assistant batch (providers require adjacency).
      if (
        call.status === "completed" &&
        input.index - round.index <= level.imageRounds
      ) {
        if (call.name === "view_image") {
          const image = imageMessage(input.protocol, call.rawOutput);
          if (image) images.push(image);
        } else if (call.name === "render_document")
          images.push(...renderedPageMessages(input.protocol, call.rawOutput));
      }
    }
    if (results.length) messages.push({ role: "user", content: results });
    messages.push(...images);
  }
  return messages;
}
