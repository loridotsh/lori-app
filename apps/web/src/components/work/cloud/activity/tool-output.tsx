"use client";

import type { CloudToolInvocation } from "@lori-enterprise/contracts";
import { FileIcon, FolderIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatSize } from "../cloud-files";
import { diffStats, lineDiff, type DiffLine } from "./diff";
import { OutputBlock } from "./output-block";
import { isRecord, num, safeJson, str, type Rec } from "./output-values";
import { GenericFields, Note, StructuredValue, richResult } from "./tool-results";

export { OutputBlock, safeJson };

function CommandResult({ command, output }: { command: string; output: Rec }) {
  const exit = num(output.exitCode);
  const stdout = str(output.stdout);
  const stderr = str(output.stderr);
  const hint = str(output.hint);
  return (
    <div className="space-y-2">
      {command ? (
        <pre
          tabIndex={0}
          className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-secondary/40 px-3 py-2 font-mono text-xs leading-5"
        >
          <span aria-hidden className="mr-2 text-muted-foreground">$</span>
          {command}
        </pre>
      ) : null}
      {hint ? <Note tone="warning">{hint}</Note> : null}
      {stdout ? <OutputBlock label="Output" text={stdout} copyLabel="Copy output" /> : null}
      {stderr ? <OutputBlock label="Error output" text={stderr} tone="error" copyLabel="Copy error output" /> : null}
      {!stdout && !stderr ? (
        <p className="text-xs text-muted-foreground">The command printed no output.</p>
      ) : null}
      {exit !== null ? (
        <p
          className={cn(
            "text-[11px]",
            exit === 0 ? "text-muted-foreground" : "font-medium text-destructive",
          )}
        >
          {exit === 0 ? "Finished successfully" : `Exited with code ${exit}`}
        </p>
      ) : null}
    </div>
  );
}

function FileList({ output }: { output: Rec }) {
  const files = Array.isArray(output.files) ? output.files.filter(isRecord) : [];
  if (!files.length)
    return <p className="text-xs text-muted-foreground">No files found.</p>;
  return (
    <div>
      <ul className="divide-y divide-border/60 rounded-md border border-border">
        {files.slice(0, 50).map((file, index) => {
          const path = str(file.path);
          const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
          const size = num(file.sizeBytes);
          return (
            <li key={`${path}:${index}`} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" title={path}>
                {folder ? <span className="text-muted-foreground">{folder}/</span> : null}
                {path.split("/").at(-1)}
              </span>
              {size !== null ? (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{formatSize(size)}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {files.length > 50 || output.truncated === true ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {files.length > 50 ? `Showing 50 of ${files.length}. ` : ""}
          {output.truncated === true ? "More files match than were listed." : ""}
        </p>
      ) : null}
    </div>
  );
}

function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-primary/15 px-0.5 text-foreground">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

function SearchMatches({ output, query }: { output: Rec; query: string }) {
  const matches = Array.isArray(output.matches) ? output.matches.filter(isRecord) : [];
  if (!matches.length)
    return <p className="text-xs text-muted-foreground">No matches found.</p>;
  return (
    <div>
      <ul className="divide-y divide-border/60 rounded-md border border-border">
        {matches.slice(0, 30).map((match, index) => (
          <li key={index} className="px-3 py-1.5 text-xs">
            <p className="truncate text-muted-foreground">
              <span className="text-foreground">{str(match.path)}</span>
              <span aria-hidden> · </span>
              <span className="sr-only">line </span>
              {num(match.line) ?? ""}
            </p>
            <p className="mt-0.5 break-words font-mono text-[11px] leading-5 [overflow-wrap:anywhere]">
              {highlight(str(match.text), query)}
            </p>
          </li>
        ))}
      </ul>
      {matches.length > 30 || output.truncated === true ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {matches.length > 30 ? `Showing 30 of ${matches.length}. ` : ""}
          {output.truncated === true ? "More matches exist than were returned." : ""}
        </p>
      ) : null}
    </div>
  );
}

/** read_file output numbers lines as "12: text"; split that into a gutter. */
function parseNumbered(text: string): { number: string; text: string }[] | null {
  const lines = text.split("\n");
  const parsed = lines.map((line) => /^(\d+): ?(.*)$/s.exec(line));
  if (!parsed.length || parsed.some((match) => !match)) return null;
  return parsed.map((match) => ({ number: match![1]!, text: match![2]! }));
}

function FileText({ output }: { output: Rec }) {
  const text = str(output.text);
  const [shown, setShown] = useState(200);
  if (!text) return <p className="text-xs text-muted-foreground">The file is empty.</p>;
  const numbered = parseNumbered(text);
  const rows = numbered ?? text.split("\n").map((line) => ({ number: "", text: line }));
  return (
    <div className="overflow-hidden rounded-md border border-border bg-secondary/40">
      <div className="max-h-80 overflow-auto" tabIndex={0}>
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <tbody>
            {rows.slice(0, shown).map((row, index) => (
              <tr key={index}>
                {numbered ? (
                  <td className="select-none whitespace-nowrap border-r border-border/60 bg-secondary/60 px-2 text-right align-top text-[11px] text-muted-foreground">
                    {row.number}
                  </td>
                ) : null}
                <td className="whitespace-pre-wrap break-words px-3 align-top [overflow-wrap:anywhere]">
                  {row.text || " "}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown ? (
        <button
          type="button"
          className="w-full border-t border-border/70 px-3 py-1.5 text-left text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => setShown((value) => value + 200)}
        >
          Show more · {rows.length - shown} more lines
        </button>
      ) : null}
      {output.truncated === true ? (
        <p className="border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
          The file continues beyond what was read.
        </p>
      ) : null}
    </div>
  );
}

export function DiffView({ lines, limit = 80 }: { lines: DiffLine[]; limit?: number }) {
  const [shown, setShown] = useState(limit);
  const stats = diffStats(lines);
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <p className="flex gap-3 border-b border-border/70 bg-secondary/60 px-3 py-1 text-[11px] tabular-nums">
        <span className="text-success-muted-foreground">+{stats.added}</span>
        <span className="text-destructive">−{stats.removed}</span>
      </p>
      <div className="max-h-80 overflow-auto font-mono text-xs leading-5" tabIndex={0} role="group" aria-label="Changes">
        {lines.slice(0, shown).map((line, index) => (
          <div
            key={index}
            className={cn(
              "flex gap-2 whitespace-pre-wrap break-words px-3 [overflow-wrap:anywhere]",
              line.type === "add" && "bg-success-muted text-success-muted-foreground",
              line.type === "del" && "bg-destructive-muted text-destructive-muted-foreground",
            )}
          >
            <span aria-hidden className="w-3 shrink-0 select-none">
              {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
            </span>
            <span className="sr-only">
              {line.type === "add" ? "Added: " : line.type === "del" ? "Removed: " : "Unchanged: "}
            </span>
            <span className="min-w-0">{line.text || " "}</span>
          </div>
        ))}
      </div>
      {lines.length > shown ? (
        <button
          type="button"
          className="w-full border-t border-border/70 px-3 py-1.5 text-left text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => setShown((value) => value + limit)}
        >
          Show more · {lines.length - shown} more lines
        </button>
      ) : null}
    </div>
  );
}

/** What an edit or write changed, from the arguments the model supplied. */
export function changeDiff(name: string, args: Rec): DiffLine[] | null {
  if (name === "edit_file" && typeof args.oldText === "string" && typeof args.newText === "string")
    return lineDiff(args.oldText, args.newText);
  if (name === "write_file" && typeof args.content === "string")
    return lineDiff("", args.content);
  return null;
}

function FileChange({ invocation, output }: { invocation: CloudToolInvocation; output: Rec }) {
  const file = isRecord(output.file) ? output.file : null;
  const diff = changeDiff(invocation.name, invocation.arguments);
  const created = invocation.name === "write_file" && !str(invocation.arguments.expectedHash);
  return (
    <div className="space-y-2">
      {file ? (
        <p className="text-xs text-muted-foreground">
          <span className="text-foreground">{str(file.path)}</span>
          {" · "}
          {created ? "Created" : "Updated"}
          {num(file.version) ? ` · version ${num(file.version)}` : ""}
          {num(file.sizeBytes) !== null ? ` · ${formatSize(num(file.sizeBytes)!)}` : ""}
        </p>
      ) : null}
      {diff ? <DiffView lines={diff} /> : null}
    </div>
  );
}

function ManageResult({ output }: { output: Rec }) {
  const file = isRecord(output.file) ? output.file : null;
  const text = output.trashed
    ? `Moved ${str(output.path)} to Trash`
    : output.moved
      ? `Moved to ${str(output.path)}`
      : file
        ? `Created ${str(file.path)}`
        : "Done";
  return (
    <p className="flex items-center gap-2 text-xs">
      <FolderIcon aria-hidden className="size-3.5 text-muted-foreground" />
      {text}
    </p>
  );
}

function MemoryResult({ output }: { output: Rec }) {
  const notes = Array.isArray(output.notes) ? output.notes.filter(isRecord) : [output];
  const shown = notes.filter((note) => str(note.topic) || str(note.content));
  if (!shown.length) return <p className="text-xs text-muted-foreground">No matching notes.</p>;
  return (
    <ul className="space-y-2">
      {shown.slice(0, 10).map((note, index) => (
        <li key={index} className="rounded-md bg-secondary/40 px-3 py-2">
          <p className="text-xs font-medium">{str(note.topic)}</p>
          <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            {str(note.content)}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The arguments exactly as they will be sent, for an approval card. Nothing is
 * redacted or cut: a member approving an action must see all of it, and these
 * values are their own request, not a result that might echo a secret back.
 */
export function exactJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}

/**
 * Any result or set of inputs, laid out as readable fields. `inputs` is for the
 * member's own arguments, where nothing but credentials is hidden.
 */
export function GenericResult({ output, inputs = false }: { output: unknown; inputs?: boolean }) {
  if (!isRecord(output)) return <StructuredValue value={output} />;
  return <GenericFields output={output} inputs={inputs} />;
}

/** Chooses the right view of a tool's result. Unknown shapes fall back to a safe field list. */
export function ToolResult({
  invocation,
  output,
}: {
  invocation: CloudToolInvocation;
  output: unknown;
}) {
  const args = invocation.arguments ?? {};
  if (isRecord(output) && typeof output.error === "string" && !("files" in output))
    return (
      <div className="space-y-2">
        <p role="status" className="text-xs leading-5 text-destructive">
          {str(output.message) || "This step did not complete."}
        </p>
        {str(output.hint) ? <Note>{str(output.hint)}</Note> : null}
      </div>
    );
  if (!isRecord(output)) return <GenericResult output={output} />;
  switch (invocation.name) {
    case "web_search":
    case "web_fetch": {
      const content = Array.isArray(output.content) ? output.content
        .filter(isRecord).map((part) => str(part.text)).filter(Boolean).join("\n\n") : str(output.preview);
      return <OutputBlock label={invocation.name === "web_search" ? "Search results" : "Webpage content"} text={content || "No readable content returned."} />;
    }
    case "run_command":
      return <CommandResult command={str(args.command)} output={output} />;
    case "list_files":
    case "search_files":
      return <FileList output={output} />;
    case "search_text":
      return <SearchMatches output={output} query={str(args.query)} />;
    case "read_file":
    case "read_document":
      return <FileText output={output} />;
    case "write_file":
    case "edit_file":
      return <FileChange invocation={invocation} output={output} />;
    case "manage_files":
      return <ManageResult output={output} />;
    case "memory_search":
    case "memory_read":
    case "memory_update":
      return <MemoryResult output={output} />;
    default: {
      const rich = richResult(invocation, output);
      if (rich) return rich;
      return "stdout" in output || "stderr" in output || "exitCode" in output ? (
        <CommandResult command="" output={output} />
      ) : (
        <GenericResult output={output} />
      );
    }
  }
}
