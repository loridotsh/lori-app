import type { CloudToolInvocation } from "@lori-enterprise/contracts";
import {
  BookOpenIcon,
  BrainIcon,
  CircleAlertIcon,
  ClockIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  ImageIcon,
  PencilLineIcon,
  PlugIcon,
  SearchIcon,
  ShieldQuestionIcon,
  SquareTerminalIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";

export type ToolKind =
  | "read"
  | "search"
  | "write"
  | "files"
  | "command"
  | "document"
  | "memory"
  | "plugin"
  | "discovery"
  | "result"
  | "skill"
  | "web"
  | "other";

export interface ToolView {
  kind: ToolKind;
  Icon: LucideIcon;
  /** Shown while the call is in flight ("Reading"). */
  active: string;
  /** Shown once it has finished ("Read"). */
  past: string;
  /** What the call acts on, in plain text: a path, a query, a command. */
  subject: string;
  /** Plugin ID, so the row can show the service's logo. */
  plugin?: string;
}

type Args = Record<string, unknown>;
const str = (value: unknown): string =>
  typeof value === "string" ? value : "";
const oneLine = (value: string, max = 90): string => {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
/** A command's first line, marked when more follows: a script is not a sentence to run together. */
const commandLine = (value: string): string => {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const head = oneLine(lines[0] ?? "");
  return lines.length > 1 && !head.endsWith("…") ? `${head} …` : head;
};
const humanize = (name: string) =>
  name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
const capitalize = (value: string) =>
  value ? value[0]!.toUpperCase() + value.slice(1) : value;

const PLUGIN_NAMES: Record<string, string> = {
  notion: "Notion",
  linear: "Linear",
  github: "GitHub",
  slack: "Slack",
  asana: "Asana",
  clickup: "ClickUp",
  miro: "Miro",
  intercom: "Intercom",
  sentry: "Sentry",
  exa: "Exa",
};
/** Display names of the bundled plugins, for recognizing them in text. */
export const KNOWN_PLUGIN_NAMES: string[] = Object.values(PLUGIN_NAMES);
export const pluginName = (id: string): string =>
  Object.hasOwn(PLUGIN_NAMES, id)
    ? PLUGIN_NAMES[id]!
    : capitalize(humanize(id));

/** Plain-language description of one tool call. Unknown tools degrade to a readable name. */
export function describeTool(call: {
  name: string;
  arguments: Args;
}): ToolView {
  const args = call.arguments ?? {};
  const path = str(args.path);
  switch (call.name) {
    case "web_search":
      return {
        kind: "web",
        Icon: SearchIcon,
        active: "Searching the web",
        past: "Searched the web",
        subject: oneLine(`“${str(args.query)}”`),
      };
    case "web_fetch": {
      let subject = str(args.url);
      try {
        subject = new URL(subject).hostname;
      } catch {
        /* Keep the supplied label. */
      }
      return {
        kind: "web",
        Icon: GlobeIcon,
        active: "Reading webpage",
        past: "Read webpage",
        subject: oneLine(subject),
      };
    }
    case "list_files":
      return {
        kind: "read",
        Icon: FolderIcon,
        active: "Listing files",
        past: "Listed files",
        subject: path || "all files",
      };
    case "search_files":
      return {
        kind: "search",
        Icon: SearchIcon,
        active: "Searching file names",
        past: "Searched file names",
        subject: oneLine(`“${str(args.query)}”`),
      };
    case "search_text":
      return {
        kind: "search",
        Icon: SearchIcon,
        active: "Searching text",
        past: "Searched text",
        subject: oneLine(`“${str(args.query)}”`),
      };
    case "read_file":
      return {
        kind: "read",
        Icon: FileTextIcon,
        active: "Reading",
        past: "Read",
        subject: path || "a file",
      };
    case "read_document":
      return {
        kind: "document",
        Icon: FileTextIcon,
        active: "Reading document",
        past: "Read document",
        subject: path || "a document",
      };
    case "read_tool_output":
      return {
        kind: "result",
        Icon: FileTextIcon,
        active: "Reading saved result",
        past: "Read saved result",
        subject: "",
      };
    case "read_todos":
      return { kind:"read", Icon:FileTextIcon, active:"Reading tasks", past:"Read tasks", subject:"" };
    case "write_todos":
      return { kind:"other", Icon:FileTextIcon, active:"Updating tasks", past:"Updated tasks", subject:"" };
    case "update_task_progress":
      return { kind: "other", Icon: FileTextIcon, active: "Saving task progress", past: "Saved task progress", subject: "" };
    case "read_conversation_history":
      return { kind: "read", Icon: FileTextIcon, active: "Reviewing earlier messages", past: "Reviewed earlier messages", subject: "" };
    case "write_file":
      return {
        kind: "write",
        Icon: PencilLineIcon,
        active: "Writing",
        past: "Wrote",
        subject: path || "a file",
      };
    case "edit_file":
      return {
        kind: "write",
        Icon: PencilLineIcon,
        active: "Editing",
        past: "Edited",
        subject: path || "a file",
      };
    case "manage_files": {
      const action = str(args.action);
      const verbs: Record<string, [string, string]> = {
        copy: ["Copying", "Copied"],
        move: ["Moving", "Moved"],
        trash: ["Moving to Trash", "Moved to Trash"],
      };
      const [active, past] = verbs[action] ?? [
        "Organizing files",
        "Organized files",
      ];
      return {
        kind: "files",
        Icon: FolderIcon,
        active,
        past,
        subject: oneLine(
          action === "copy" || action === "move"
            ? `${path} → ${str(args.destination)}`
            : path,
        ),
      };
    }
    case "run_command":
      return {
        kind: "command",
        Icon: SquareTerminalIcon,
        active: "Running",
        past: "Ran",
        subject: commandLine(str(args.command)),
      };
    case "inspect_document":
      return {
        kind: "document",
        Icon: FileTextIcon,
        active: "Inspecting",
        past: "Inspected",
        subject: path,
      };
    case "validate_document":
      return {
        kind: "document",
        Icon: FileTextIcon,
        active: "Validating",
        past: "Validated",
        subject: path,
      };
    case "render_document":
      return {
        kind: "document",
        Icon: ImageIcon,
        active: "Rendering",
        past: "Rendered",
        subject: path,
      };
    case "convert_document":
      return {
        kind: "document",
        Icon: FileTextIcon,
        active: "Converting",
        past: "Converted",
        subject: oneLine(`${path} → ${str(args.outputPath)}`),
      };
    case "recalculate_spreadsheet":
      return {
        kind: "document",
        Icon: FileTextIcon,
        active: "Recalculating",
        past: "Recalculated",
        subject: path,
      };
    case "view_image":
      return {
        kind: "document",
        Icon: ImageIcon,
        active: "Viewing",
        past: "Viewed",
        subject: path,
      };
    case "memory_search":
      return {
        kind: "memory",
        Icon: BrainIcon,
        active: "Searching memory",
        past: "Searched memory",
        subject: oneLine(`“${str(args.query)}”`),
      };
    case "memory_read":
      return {
        kind: "memory",
        Icon: BrainIcon,
        active: "Reading a memory note",
        past: "Read a memory note",
        subject: "",
      };
    case "memory_update":
      return {
        kind: "memory",
        Icon: BrainIcon,
        active: "Saving to memory",
        past: "Saved to memory",
        subject: oneLine(str(args.topic)),
      };
    case "search_plugin_tools": {
      const plugin = str(args.pluginId);
      return {
        kind: "discovery",
        Icon: PlugIcon,
        active: "Looking for tools",
        past: "Looked for tools",
        subject: plugin ? pluginName(plugin) : oneLine(str(args.query)),
        ...(plugin ? { plugin } : {}),
      };
    }
    case "call_plugin_tool": {
      const plugin = str(args.pluginId);
      return {
        kind: "plugin",
        Icon: PlugIcon,
        active: "Using",
        past: "Used",
        subject: oneLine(
          [plugin ? pluginName(plugin) : "", str(args.name)]
            .filter(Boolean)
            .join(" · "),
        ),
        ...(plugin ? { plugin } : {}),
      };
    }
    case "read_plugin_resource": {
      const plugin = str(args.pluginId);
      return {
        kind: "plugin",
        Icon: PlugIcon,
        active: "Reading from",
        past: "Read from",
        subject: plugin ? pluginName(plugin) : "a plugin",
        ...(plugin ? { plugin } : {}),
      };
    }
    case "load_skill":
      return {
        kind: "skill",
        Icon: BookOpenIcon,
        active: "Loading skill",
        past: "Loaded skill",
        subject: capitalize(humanize(str(args.id))),
      };
    default: {
      const label = capitalize(humanize(call.name));
      return {
        kind: "other",
        Icon: WrenchIcon,
        active: label,
        past: label,
        subject: "",
      };
    }
  }
}

export type ToolStatus = CloudToolInvocation["status"];
export const statusLabel: Record<ToolStatus, string> = {
  pendingApproval: "Needs approval",
  pendingExecution: "Queued",
  running: "Running",
  completed: "Done",
  failed: "Failed",
  denied: "Declined",
  unknown: "Outcome unknown",
};

/**
 * The icon that stands for the row's state; finished and running rows keep the
 * tool's own icon. `shimmer` marks work in progress: the row's text shimmers
 * instead of the icon spinning.
 */
export function statusIcon(
  status: ToolStatus,
  toolIcon: LucideIcon,
): { Icon: LucideIcon; shimmer: boolean; tone: "default" | "warning" | "error" } {
  switch (status) {
    case "running":
      return { Icon: toolIcon, shimmer: true, tone: "default" };
    case "pendingApproval":
      return { Icon: ShieldQuestionIcon, shimmer: false, tone: "warning" };
    case "pendingExecution":
      return { Icon: ClockIcon, shimmer: true, tone: "default" };
    case "failed":
    case "unknown":
      return { Icon: CircleAlertIcon, shimmer: false, tone: "error" };
    case "denied":
      return { Icon: XIcon, shimmer: false, tone: "default" };
    default:
      return { Icon: toolIcon, shimmer: false, tone: "default" };
  }
}

/** "820ms", "3.4s", "1m 12s". Empty when the duration is unknown or meaningless. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const KIND_PHRASES: Record<ToolKind, [string, string, string]> = {
  read: ["read", "file", "files"],
  search: ["searched", "time", "times"],
  write: ["edited", "file", "files"],
  files: ["organized", "file", "files"],
  command: ["ran", "command", "commands"],
  document: ["worked on", "document", "documents"],
  memory: ["used", "memory lookup", "memory lookups"],
  plugin: ["ran", "plugin action", "plugin actions"],
  discovery: ["made", "tool lookup", "tool lookups"],
  result: ["read", "saved result", "saved results"],
  skill: ["loaded", "skill", "skills"],
  web: ["checked", "web source", "web sources"],
  other: ["used", "tool", "tools"],
};

/** "Read 3 files, ran 2 commands" for a collapsed group. */
export function summarizeActivity(
  calls: { name: string; arguments: Args }[],
): string {
  const counts = new Map<ToolKind, number>();
  for (const call of calls) {
    const { kind } = describeTool(call);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = [...counts].map(([kind, count]) => {
    const [verb, one, many] = KIND_PHRASES[kind];
    return `${verb} ${count} ${count === 1 ? one : many}`;
  });
  return capitalize(parts.join(", "));
}
