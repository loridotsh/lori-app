"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Characters shown before "Show more" for long text. */
export const OUTPUT_PAGE = 16_000;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      aria-label={copied ? `${label} copied` : label}
      title={copied ? "Copied" : label}
      className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1800);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <CheckIcon aria-hidden className="size-3" /> : <CopyIcon aria-hidden className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** A bounded, scrollable block of text with a caption, copy, and paging for long output. */
export function OutputBlock({
  label,
  text,
  tone = "default",
  copyLabel = "Copy output",
}: {
  label: string;
  text: string;
  tone?: "default" | "error";
  copyLabel?: string;
}) {
  const [shown, setShown] = useState(OUTPUT_PAGE);
  const visible = text.length > shown ? text.slice(0, shown) : text;
  return (
    <div className="overflow-hidden rounded-md border border-border bg-secondary/40">
      <div className="flex h-7 items-center justify-between border-b border-border/70 bg-secondary/60 pl-3 pr-1">
        <span
          className={cn(
            "text-[11px] font-medium",
            tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
        <CopyButton text={text} label={copyLabel} />
      </div>
      <pre
        tabIndex={0}
        className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 [overflow-wrap:anywhere]"
      >
        {visible}
      </pre>
      {text.length > shown ? (
        <button
          type="button"
          className="w-full border-t border-border/70 px-3 py-1.5 text-left text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => setShown((value) => value + OUTPUT_PAGE)}
        >
          Show more · {(text.length - shown).toLocaleString("en-US")} more characters
        </button>
      ) : null}
    </div>
  );
}
