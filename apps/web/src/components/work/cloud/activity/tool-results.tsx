"use client";

import type { CloudToolInvocation } from "@lori-enterprise/contracts";
import { CheckIcon, CircleAlertIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { OutputBlock, OUTPUT_PAGE } from "./output-block";
import {
  HIDDEN_KEYS,
  SENSITIVE,
  formatNumber,
  humanize,
  isPrimitive,
  isRecord,
  num,
  parseEmbeddedJson,
  safeJson,
  str,
  type Rec,
} from "./output-values";

/** Never shown at any depth: they only identify a stored connection. */
const INTERNAL_KEYS = new Set(["schemaHash", "connectionId", "connectionRevision"]);
const MAX_ROWS = 20;
const MAX_COLUMNS = 5;
const MAX_DEPTH = 3;

/* ------------------------------------------------------------------ pieces */

export function Note({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning" | "error";
  children: ReactNode;
}) {
  const Icon = tone === "info" ? InfoIcon : tone === "warning" ? TriangleAlertIcon : CircleAlertIcon;
  return (
    <p
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-5",
        tone === "info" && "bg-secondary/60 text-muted-foreground",
        tone === "warning" && "bg-warning-muted text-warning-muted-foreground",
        tone === "error" && "bg-destructive-muted text-destructive-muted-foreground",
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}

function Badge({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "success" | "warning" | "error" }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium",
        tone === "default" && "bg-secondary text-muted-foreground",
        tone === "success" && "bg-success-muted text-success-muted-foreground",
        tone === "warning" && "bg-warning-muted text-warning-muted-foreground",
        tone === "error" && "bg-destructive-muted text-destructive-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="text-[11px] text-muted-foreground">{children}</p>;
}

function Chips({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1">
      {items.map((item, index) => (
        <li
          key={`${item}:${index}`}
          className="max-w-full truncate rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[11px]"
          title={item}
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

function Disclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="text-xs">
      <summary className="w-fit cursor-pointer text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        {summary}
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

/* --------------------------------------------------------- generic renderer */

/**
 * `result` is true for the top level of a tool's output, where packaging
 * bookkeeping and the hint are hidden (the hint is shown as a note). Inside
 * nested data, and for a member's own inputs, only credentials-style keys are.
 */
function visibleEntries(record: Rec, result: boolean): [string, unknown][] {
  return Object.entries(record).filter(([key, value]) => {
    if (result ? HIDDEN_KEYS.has(key) || key === "hint" : INTERNAL_KEYS.has(key)) return false;
    if (value === null || value === undefined) return false;
    if (typeof value === "string" && !value.trim()) return false;
    if (Array.isArray(value) && !value.length) return false;
    if (isRecord(value) && !Object.keys(value).length) return false;
    return true;
  });
}

/**
 * The plain columns shared by a list of records. `lossless` is false when some
 * record carries nested values a table would have to drop.
 */
function tableColumns(rows: Rec[]): { columns: string[]; lossless: boolean } {
  const columns: string[] = [];
  let lossless = true;
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (INTERNAL_KEYS.has(key) || SENSITIVE.test(key)) continue;
      if (!isPrimitive(value)) {
        if (!(Array.isArray(value) && !value.length)) lossless = false;
        continue;
      }
      if (!columns.includes(key) && rows.every((other) => other[key] === undefined || isPrimitive(other[key])))
        columns.push(key);
    }
  }
  return { columns, lossless };
}

function RecordTable({ rows, total }: { rows: Rec[]; total: number }) {
  const { columns } = tableColumns(rows);
  const shown = columns.slice(0, MAX_COLUMNS);
  if (!shown.length) return null;
  const visible = rows.slice(0, MAX_ROWS);
  return (
    <div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-border/70 bg-secondary/60">
              {shown.map((column) => (
                <th key={column} scope="col" className="whitespace-nowrap px-2.5 py-1.5 font-medium text-muted-foreground">
                  {humanize(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {visible.map((row, index) => (
              <tr key={index}>
                {shown.map((column) => {
                  const value = row[column];
                  return (
                    <td
                      key={column}
                      className={cn(
                        "max-w-64 px-2.5 py-1.5 align-top",
                        typeof value === "number" && "text-right tabular-nums",
                      )}
                    >
                      <span className="line-clamp-3 break-words [overflow-wrap:anywhere]">
                        {value === null || value === undefined
                          ? ""
                          : typeof value === "number"
                            ? formatNumber(value)
                            : typeof value === "boolean"
                              ? value ? "Yes" : "No"
                              : String(value)}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > visible.length || columns.length > shown.length ? (
        <Caption>
          {total > visible.length ? `Showing ${visible.length} of ${total}. ` : ""}
          {columns.length > shown.length ? `${columns.length - shown.length} more columns not shown.` : ""}
        </Caption>
      ) : null}
    </div>
  );
}

function KeyValues({ record, depth, result = false }: { record: Rec; depth: number; result?: boolean }) {
  const entries = visibleEntries(record, result);
  if (!entries.length) return <p className="text-xs text-muted-foreground">No details were returned.</p>;
  return (
    <dl className="space-y-1.5 text-xs">
      {entries.map(([key, value]) => (
        <div
          key={key}
          className={cn(
            "grid gap-0.5",
            // Lists of records need the full width, so their label sits above them.
            !(Array.isArray(value) && value.some((item) => !isPrimitive(item))) && "sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3",
          )}
        >
          <dt className="text-muted-foreground">{humanize(key)}</dt>
          <dd className="min-w-0">
            {SENSITIVE.test(key) ? (
              <span className="text-muted-foreground">[redacted]</span>
            ) : (
              <StructuredValue value={value} depth={depth + 1} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Any JSON value, laid out for a person: scalars inline, lists as chips or
 * tables, nested objects as indented fields, and JSON hidden inside a string
 * unpacked. Nothing here assumes a shape, so a malformed or unexpected result
 * still reads well.
 */
export function StructuredValue({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value === null || value === undefined)
    return <span className="text-muted-foreground">None</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value === "number") return <span className="tabular-nums">{formatNumber(value)}</span>;
  if (typeof value === "string") {
    const embedded = depth < MAX_DEPTH + 1 ? parseEmbeddedJson(value) : undefined;
    if (embedded !== undefined) return <StructuredValue value={embedded} depth={depth} />;
    if (value.length > 400)
      return (
        <details>
          <summary className="cursor-pointer break-words text-muted-foreground [overflow-wrap:anywhere]">
            {value.slice(0, 120)}…
          </summary>
          <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {value.slice(0, OUTPUT_PAGE)}
          </p>
        </details>
      );
    return <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{value}</span>;
  }
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-muted-foreground">None</span>;
    if (value.every((item) => typeof item === "string" || typeof item === "number")) {
      const items = value.map((item) => String(item));
      return items.length <= 24 ? (
        <Chips items={items} />
      ) : (
        <Disclosure summary={`${items.length} items`}>
          <Chips items={items.slice(0, 200)} />
        </Disclosure>
      );
    }
    if (value.every(isRecord)) {
      const { columns, lossless } = tableColumns(value);
      // One record reads better as fields than as a one-row table that clips columns.
      if (value.length > 1 && columns.length && lossless) return <RecordTable rows={value} total={value.length} />;
    }
    if (depth >= MAX_DEPTH)
      return (
        <Disclosure summary={`${value.length} items`}>
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 [overflow-wrap:anywhere]">
            {safeJson(value)}
          </pre>
        </Disclosure>
      );
    return (
      <ul className="space-y-2">
        {value.slice(0, MAX_ROWS).map((item, index) => (
          <li key={index} className="rounded-md border border-border/60 px-2.5 py-1.5">
            <StructuredValue value={item} depth={depth + 1} />
          </li>
        ))}
        {value.length > MAX_ROWS ? <Caption>Showing {MAX_ROWS} of {value.length}.</Caption> : null}
      </ul>
    );
  }
  if (isRecord(value)) {
    if (depth >= MAX_DEPTH)
      return (
        <Disclosure summary="Details">
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 [overflow-wrap:anywhere]">
            {safeJson(value)}
          </pre>
        </Disclosure>
      );
    return <KeyValues record={value} depth={depth} />;
  }
  return <span>{String(value)}</span>;
}

/** The fallback for any result: a note for `hint`, then the fields. */
export function GenericFields({ output, inputs = false }: { output: Rec; inputs?: boolean }) {
  const result = !inputs;
  const hint = result ? str(output.hint) : "";
  const entries = visibleEntries(output, result).filter(([key]) => !(result && key === "nextOffset"));
  const next = result ? num(output.nextOffset) : null;
  return (
    <div className="space-y-2">
      {hint ? <Note>{hint}</Note> : null}
      {entries.length ? (
        <KeyValues record={Object.fromEntries(entries)} depth={0} />
      ) : hint ? null : (
        <p className="text-xs text-muted-foreground">No details were returned.</p>
      )}
      {next !== null ? <Caption>More is available from position {formatNumber(next)}.</Caption> : null}
    </div>
  );
}

/* ------------------------------------------------------------ tool-specific */

const list = (value: unknown): Rec[] => (Array.isArray(value) ? value.filter(isRecord) : []);

function schemaInputs(schema: unknown): { name: string; required: boolean }[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  return Object.keys(schema.properties).map((name) => ({ name, required: required.includes(name) }));
}

function Discovery({ output }: { output: Rec }) {
  const tools = list(output.tools);
  const total = num(output.total) ?? tools.length;
  const offset = num(output.offset) ?? 0;
  const resources = list(output.resources);
  const next = num(output.nextOffset);
  return (
    <div className="space-y-2">
      {!tools.length ? (
        <p className="text-xs text-muted-foreground">No matching tools were found.</p>
      ) : (
        <>
          <Caption>
            {total === 1 ? "1 tool" : `${formatNumber(total)} tools`} found
            {tools.length < total ? ` · showing ${offset + 1}–${offset + tools.length}` : ""}
          </Caption>
          <ul className="divide-y divide-border/60 rounded-md border border-border">
            {tools.map((tool, index) => {
              const inputs = schemaInputs(tool.inputSchema);
              return (
                <li key={`${str(tool.pluginId)}:${str(tool.name)}:${index}`} className="space-y-1 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 break-all font-mono font-medium">{str(tool.name)}</span>
                    {str(tool.pluginId) ? <Badge>{humanize(str(tool.pluginId))}</Badge> : null}
                    {tool.readOnly === true ? (
                      <Badge tone="success">Read only</Badge>
                    ) : tool.readOnly === false ? (
                      <Badge tone="warning">Can change data</Badge>
                    ) : null}
                  </div>
                  {str(tool.description) ? (
                    <p className="line-clamp-2 leading-5 text-muted-foreground">{str(tool.description)}</p>
                  ) : null}
                  {inputs.length ? (
                    <p className="text-[11px] text-muted-foreground">
                      Inputs:{" "}
                      {inputs.map((input, position) => (
                        <span key={input.name}>
                          {position ? ", " : ""}
                          <span className="font-mono text-foreground">{input.name}</span>
                          {input.required ? <span title="Required"> *</span> : null}
                        </span>
                      ))}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {next !== null ? <Caption>More tools are available.</Caption> : null}
        </>
      )}
      {resources.length ? (
        <Disclosure summary={`${resources.length} resource${resources.length === 1 ? "" : "s"} available`}>
          <ul className="space-y-1">
            {resources.map((resource, index) => (
              <li key={index} className="text-xs">
                <span className="font-medium">{str(resource.name) || str(resource.uri)}</span>
                {str(resource.uri) && str(resource.name) ? (
                  <span className="ml-2 break-all font-mono text-[11px] text-muted-foreground">{str(resource.uri)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  );
}

function Skill({ output }: { output: Rec }) {
  const content = str(output.content);
  const references = Array.isArray(output.references) ? output.references.map(String) : [];
  const reference = str(output.reference);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{humanize(str(output.id) || "skill")}</span>
        {str(output.version) ? ` · version ${str(output.version)}` : ""}
        {reference && reference !== "SKILL.md" ? ` · ${reference}` : ""}
        {content ? ` · ${formatNumber(content.length)} characters` : ""}
      </p>
      {references.length ? <Chips items={references} /> : null}
      {content ? (
        <Disclosure summary="Show instructions">
          <OutputBlock label={reference || "SKILL.md"} text={content} copyLabel="Copy instructions" />
        </Disclosure>
      ) : (
        <Note tone="warning">No instructions were returned for this skill.</Note>
      )}
    </div>
  );
}

function SavedOutput({ output }: { output: Rec }) {
  const text = str(output.text);
  const next = num(output.nextOffset);
  const embedded = parseEmbeddedJson(text);
  const shown = embedded !== undefined ? JSON.stringify(embedded, null, 2) : text;
  return (
    <div className="space-y-2">
      {text ? (
        <OutputBlock label="Earlier result" text={shown} />
      ) : (
        <p className="text-xs text-muted-foreground">The saved result is empty.</p>
      )}
      {next !== null ? <Caption>The result continues; the next part starts at position {formatNumber(next)}.</Caption> : null}
    </div>
  );
}

function Inspection({ output }: { output: Rec }) {
  const sheets = list(output.sheets);
  const blocks = list(output.blocks);
  const parts = list(output.parts);
  const warnings = Array.isArray(output.warnings) ? output.warnings.map(String) : [];
  const total = num(output.totalBlocks);
  const slides = num(output.slideCount) ?? num(output.slides);
  const pages = num(output.pageCount) ?? num(output.pages);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        <span className="break-all font-medium text-foreground">{str(output.path)}</span>
        {str(output.format) ? ` · ${str(output.format).toUpperCase()}` : ""}
        {sheets.length ? ` · ${sheets.length} sheet${sheets.length === 1 ? "" : "s"}` : ""}
        {slides !== null ? ` · ${slides} slide${slides === 1 ? "" : "s"}` : ""}
        {pages !== null ? ` · ${pages} page${pages === 1 ? "" : "s"}` : ""}
      </p>
      {warnings.map((warning, index) => (
        <Note key={index} tone="warning">{warning}</Note>
      ))}
      {sheets.length ? <RecordTable rows={sheets} total={sheets.length} /> : null}
      {blocks.length ? (
        <>
          <ul className="divide-y divide-border/60 rounded-md border border-border">
            {blocks.slice(0, 12).map((block, index) => {
              const where = [str(block.sheet), str(block.cell)].filter(Boolean).join("!");
              const text = str(block.text) || str(block.value) || str(block.cachedValue);
              return (
                <li key={index} className="flex gap-3 px-3 py-1.5 text-xs">
                  <span className="w-20 shrink-0 truncate text-muted-foreground" title={where || str(block.kind)}>
                    {where || humanize(str(block.kind) || "block")}
                  </span>
                  <span className="line-clamp-2 min-w-0 break-words [overflow-wrap:anywhere]">{text}</span>
                </li>
              );
            })}
          </ul>
          <Caption>
            Showing {Math.min(blocks.length, 12)} of {formatNumber(total ?? blocks.length)} items
            {num(output.nextOffset) !== null || num(output.nextRow) !== null ? "; the model can read on." : "."}
          </Caption>
        </>
      ) : null}
      {parts.length ? (
        <Disclosure summary={`${parts.length} package parts`}>
          <Chips items={parts.map((part) => str(part.name))} />
        </Disclosure>
      ) : null}
    </div>
  );
}

function Validation({ output }: { output: Rec }) {
  const checks = Array.isArray(output.checks) ? output.checks.map(String) : [];
  const warnings = Array.isArray(output.warnings) ? output.warnings.map(String) : [];
  const integrity = str(output.integrity);
  const passed = integrity === "passed";
  const slides = num(output.slideCount);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="break-all font-medium">{str(output.path)}</span>
        {str(output.format) ? <Badge>{str(output.format).toUpperCase()}</Badge> : null}
        {integrity ? <Badge tone={passed ? "success" : "error"}>{passed ? "Structure valid" : humanize(integrity)}</Badge> : null}
        {slides !== null ? <Badge>{slides} slides</Badge> : null}
      </div>
      {checks.length ? (
        <ul className="space-y-1 text-xs">
          {checks.map((check, index) => (
            <li key={index} className="flex items-start gap-2">
              <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success-muted-foreground" />
              <span>{check}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {warnings.map((warning, index) => (
        <Note key={index} tone="warning">{warning}</Note>
      ))}
      {str(output.visualReview) === "notReviewed" ? (
        <Caption>This checks structure only. Layout is checked by looking at the rendered pages.</Caption>
      ) : null}
    </div>
  );
}

type Picture = { src: string; label: string };

function pictures(output: Rec): Picture[] {
  const found: Picture[] = [];
  const add = (item: Rec, fallback: string) => {
    const data = str(item.data);
    const mime = str(item.mimeType) || "image/png";
    if (data && /^image\/(png|jpeg|webp|gif)$/.test(mime) && /^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 200)))
      found.push({ src: `data:${mime};base64,${data}`, label: str(item.path) || fallback });
  };
  for (const [index, image] of list(output.images).entries()) add(image, `Page ${index + 1}`);
  if (isRecord(output.image)) add(output.image, str(output.path) || "Image");
  return found;
}

function pageLabel(path: string, index: number): string {
  const match = /page-(\d+)\.\w+$/.exec(path);
  return match ? `Page ${Number(match[1])}` : `Page ${index + 1}`;
}

function Pictures({ items, caption }: { items: Picture[]; caption?: ReactNode }) {
  return (
    <div className="space-y-2">
      <ul className={cn("grid gap-2", items.length > 1 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-1")}>
        {items.map((item, index) => (
          <li key={index} className="overflow-hidden rounded-md border border-border bg-secondary/30">
            <img src={item.src} alt={item.label} loading="lazy" className="block h-auto w-full" />
            <p className="truncate border-t border-border/60 px-2 py-1 text-[11px] text-muted-foreground">{item.label}</p>
          </li>
        ))}
      </ul>
      {caption}
    </div>
  );
}

function Rendered({ output }: { output: Rec }) {
  // Output is `{ result: { totalPages, startPage, endPage, ... }, images }` or the bare result.
  const result = isRecord(output.result) ? output.result : output;
  const total = num(result.totalPages);
  const start = num(result.startPage);
  const end = num(result.endPage);
  const items = pictures(output).map((item, index) => ({ ...item, label: pageLabel(item.label, index) }));
  const summary =
    total !== null && start !== null && end !== null
      ? `Pages ${start}–${end} of ${total}`
      : total !== null
        ? `${total} page${total === 1 ? "" : "s"}`
        : "";
  if (!items.length)
    return (
      <p className="text-xs text-muted-foreground">
        {summary ? `Rendered ${summary.toLowerCase()}.` : "The pages were rendered for review."}
      </p>
    );
  return <Pictures items={items} caption={summary ? <Caption>{summary}</Caption> : null} />;
}

function ViewedImage({ output }: { output: Rec }) {
  const items = pictures(output);
  if (!items.length)
    return <p className="text-xs text-muted-foreground">{str(output.path) || "The image"} was viewed.</p>;
  return <Pictures items={items} />;
}

function PluginCall({ output }: { output: Rec }) {
  const parts = list(output.content);
  if (!parts.length) return <GenericFields output={output} />;
  return (
    <div className="space-y-2">
      {parts.map((part, index) => {
        const text = str(part.text);
        if (text) {
          const embedded = parseEmbeddedJson(text);
          return embedded !== undefined ? (
            <StructuredValue key={index} value={embedded} />
          ) : (
            <OutputBlock key={index} label="Response" text={text} />
          );
        }
        if (str(part.type) === "image") return <Caption key={index}>The service returned an image.</Caption>;
        return <GenericFields key={index} output={part} />;
      })}
      <Caption>Content from an external service.</Caption>
    </div>
  );
}

function Converted({ output, invocation }: { output: Rec; invocation: CloudToolInvocation }) {
  const changed = list(output.changedFiles);
  const args = invocation.arguments ?? {};
  const target = str(args.outputPath) || str(changed[0]?.path);
  const result = isRecord(output.result) ? output.result : output;
  const warnings = Array.isArray(result.warnings) ? result.warnings.map(String) : [];
  return (
    <div className="space-y-2">
      <p className="text-xs">
        {invocation.name === "recalculate_spreadsheet" ? "Recalculated " : "Converted "}
        <span className="break-all font-medium">{str(args.path)}</span>
        {target ? (
          <>
            {" to "}
            <span className="break-all font-medium">{target}</span>
          </>
        ) : null}
        <span className="text-muted-foreground"> · waiting for you to apply the file</span>
      </p>
      {warnings.map((warning, index) => (
        <Note key={index} tone="warning">{warning}</Note>
      ))}
    </div>
  );
}

/**
 * A dedicated view for tools whose results have a known shape. Returns null for
 * anything else (or an output that does not look as expected), so the caller
 * falls back to the generic field view.
 */
export function richResult(invocation: CloudToolInvocation, output: Rec): ReactNode | null {
  switch (invocation.name) {
    case "search_plugin_tools":
      return Array.isArray(output.tools) ? <Discovery output={output} /> : null;
    case "load_skill":
      return "content" in output || "references" in output ? <Skill output={output} /> : null;
    case "read_tool_output":
      return "text" in output ? <SavedOutput output={output} /> : null;
    case "inspect_document":
      return <Inspection output={output} />;
    case "validate_document":
      return <Validation output={output} />;
    case "render_document":
      return <Rendered output={output} />;
    case "view_image":
      return <ViewedImage output={output} />;
    case "call_plugin_tool":
    case "read_plugin_resource":
      return Array.isArray(output.content) ? <PluginCall output={output} /> : null;
    case "convert_document":
    case "recalculate_spreadsheet":
      return <Converted output={output} invocation={invocation} />;
    default:
      return null;
  }
}
