"use client";

import { ArrowUpRightIcon, CheckIcon, CopyIcon } from "lucide-react";
import { artifactLinkText, isArtifactFile } from "@lori-enterprise/contracts";
import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/** Model output is untrusted: no HTML, embedded remote content, or executable links. */
export function cloudLink(href?: string): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return textOf(node.props.children);
  return "";
}

function CodeBlock({ children, ...props }: ComponentProps<"pre">) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const code = isValidElement<{ className?: string; children?: ReactNode }>(
    children,
  )
    ? children
    : null;
  const language = /language-([\w+-]+)/.exec(code?.props.className ?? "")?.[1];
  const source = textOf(code?.props.children ?? children).replace(/\n$/, "");
  return (
    <div className="group/code relative overflow-hidden rounded-lg border border-border bg-secondary/60">
      <div data-conversation-search-ignore className="flex h-8 items-center justify-between border-b border-border/70 bg-secondary/80 pl-3 pr-1">
        <span className="font-mono text-[11px] text-muted-foreground">
          {language ?? "text"}
        </span>
        <button
          type="button"
          aria-label={copied ? "Code copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
          className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(source);
              setCopied(true);
              clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(false), 1800);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? (
            <CheckIcon aria-hidden className="size-3" />
          ) : (
            <CopyIcon aria-hidden className="size-3" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        {...props}
        className="overflow-x-auto p-3 text-[13px] leading-6 [&>code]:bg-transparent [&>code]:p-0"
        tabIndex={0}
      >
        {children}
      </pre>
    </div>
  );
}

/** Renders model Markdown, including progressively streamed text. */
export function CloudMarkdown({
  text,
  existingPaths,
  onOpenFile,
  artifactTitles,
}: {
  text: string;
  existingPaths?: ReadonlySet<string>;
  onOpenFile?: (path: string) => void;
  artifactTitles?: ReadonlyMap<string, string>;
}) {
  return (
    <div
      className={cn(
        "cloud-markdown break-words text-[15px] leading-7 text-foreground [overflow-wrap:anywhere] sm:text-sm",
        "[&>*+*]:mt-3 [&_h1]:mt-6 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-tight [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold [&_h4]:font-semibold",
        "[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:pl-1 [&_li>ul]:mt-1 [&_li>ol]:mt-1 [&_li+li]:mt-1 [&_li::marker]:text-muted-foreground",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground",
        "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-secondary [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_code]:font-mono [&_:not(pre)>code]:text-[0.85em]",
        "[&_hr]:my-5 [&_hr]:border-border [&_strong]:font-semibold",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => {
            // Resolve only exact conversation-owned relative paths. Never turn
            // arbitrary model URLs into authenticated file/API requests.
            let filePath: string | undefined;
            if (href && !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(href)) {
              try {
                const candidate = decodeURIComponent(href).replace(/^\.\//, "");
                if (existingPaths?.has(candidate)) filePath = candidate;
              } catch {
                // Malformed URL escapes stay noninteractive.
              }
            }
            if (filePath && onOpenFile) {
              const path = filePath;
              const artifact = isArtifactFile(path);
              const title = artifactLinkText(path, textOf(children), artifactTitles?.get(path));
              return <button type="button" onClick={() => onOpenFile(path)} title={artifact ? `Open in workspace · ${path}` : undefined} aria-label={artifact ? `Open ${title ?? textOf(children)} in workspace` : undefined}
                className="rounded-sm text-left text-primary underline underline-offset-4 outline-none hover:decoration-2 focus-visible:ring-2 focus-visible:ring-ring">
                {title ?? children}{artifact && <ArrowUpRightIcon aria-hidden className="ml-0.5 inline size-3 align-baseline" />}
              </button>;
            }
            const safe = cloudLink(href);
            return safe ? (
              <a
                href={safe}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
                className="text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          img: ({ alt }) => (
            <span className="text-muted-foreground">
              {alt ? `[Image: ${alt}]` : "[Image omitted]"}
            </span>
          ),
          pre: ({ children, node: _node, ...props }) => (
            <CodeBlock {...props}>{children}</CodeBlock>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-left text-sm [&_td]:border-t [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_th]:bg-secondary/70 [&_th]:px-3 [&_th]:py-2 [&_th]:font-medium">
                {children}
              </table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
