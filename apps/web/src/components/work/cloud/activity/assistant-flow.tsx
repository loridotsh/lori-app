"use client";

import { artifactVisualsFromTools, type CloudApproval, type CloudToolInvocation } from "@lori-enterprise/contracts";
import { Fragment, useMemo, type ComponentProps, type ReactNode } from "react";
import { CloudMarkdown } from "../cloud-markdown";
import { ChangedFiles } from "../files/changed-files";
import { changedFilePaths } from "../files/changed-paths";
import { buildFlow } from "./activity-flow";
import { CloudVisualActivity } from "../visuals/visual-activity";
import { ToolGroup } from "./tool-group";
import { TodoChecklist } from "./todo-checklist";

const GENERATED_LINK = /\[[^\]]*\]\((generated\/[^)\s]+)\)/g;

/**
 * Generated media sits beside the Markdown, not inside it: the Markdown tree
 * rebuilds on every render, which would restart a playing video.
 */
function ReplyText({
  text,
  renderFile,
  ...markdown
}: ComponentProps<typeof CloudMarkdown> & { renderFile?: (path: string) => ReactNode }) {
  const media = renderFile
    ? [...text.matchAll(GENERATED_LINK)].flatMap(([link, path]) => {
        const view = renderFile(path!);
        return view ? [{ link, path: path!, view }] : [];
      })
    : [];
  const rest = media.reduce((remaining, item) => remaining.replace(item.link, ""), text).trim();
  return (
    <div className="space-y-3">
      {rest && <CloudMarkdown text={rest} {...markdown} />}
      {media.map((item) => <Fragment key={item.path}>{item.view}</Fragment>)}
    </div>
  );
}

/**
 * A reply in the order it happened: text, the tools the model used, then more text.
 */
export function AssistantFlow({
  text,
  invocations,
  approvals,
  streaming = false,
  active = true,
  canExport = true,
  existingPaths,
  onOpenFile,
  renderFile,
  onChanged,
  onFailure,
}: {
  text: string;
  invocations: CloudToolInvocation[];
  approvals: CloudApproval[];
  streaming?: boolean;
  active?: boolean;
  canExport?: boolean;
  /** Paths of the conversation's current files; only these are offered under "Files from this response". */
  existingPaths?: ReadonlySet<string>;
  onOpenFile?: (path: string) => void;
  renderFile?: (path: string) => ReactNode;
  onChanged: () => Promise<void>;
  onFailure: (failure: unknown) => void;
}) {
  const parts = useMemo(() => buildFlow(text, invocations), [text, invocations]);
  const artifactVisuals = useMemo(() => artifactVisualsFromTools(invocations), [invocations]);
  const artifactTitles = useMemo(() => new Map([...artifactVisuals].map(([path, visual]) => [path, visual.title])), [artifactVisuals]);
  const changed = useMemo(
    () =>
      streaming || !onOpenFile || !existingPaths
        ? []
        : changedFilePaths(invocations).filter((path) => existingPaths.has(path)),
    [streaming, onOpenFile, existingPaths, invocations],
  );
  return (
    <div className="space-y-3">
      {parts.map((part) =>
        part.type === "text" ? (
          <div key={part.key} data-conversation-search-text={part.key}><ReplyText
            text={part.text}
            existingPaths={existingPaths}
            onOpenFile={onOpenFile}
            artifactTitles={artifactTitles}
            renderFile={renderFile}
          /></div>
        ) : part.type === "todos" ? (
          <TodoChecklist key={part.key} list={part.list} working={streaming} />
        ) : part.type === "visual" ? (
          <CloudVisualActivity key={part.key} item={part.invocation} active={active} canExport={canExport} />
        ) : (
          <ToolGroup
            key={part.key}
            invocations={part.invocations}
            approvals={approvals}
            onChanged={onChanged}
            onFailure={onFailure}
          />
        ),
      )}
      {onOpenFile ? <ChangedFiles paths={changed} onOpen={onOpenFile} artifactTitles={artifactTitles} artifactVisuals={artifactVisuals} /> : null}
    </div>
  );
}
