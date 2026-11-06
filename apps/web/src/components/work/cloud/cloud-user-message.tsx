"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { highlightMentions } from "./composer/mentions";

const COLLAPSE_LINES = 5;

/**
 * The member's own message. Large pastes (a document, a log) would otherwise
 * push the conversation far off screen, so they collapse with an explicit,
 * keyboard-reachable way to read the whole thing.
 */
export function UserMessageText({
  text,
  mentionable = [],
  revealForSearch = false,
}: {
  text: string;
  /** Names that can be mentioned (file paths, plugins, skills); matching @-tokens are highlighted. */
  mentionable?: string[];
  revealForSearch?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const paragraph = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const segments = useMemo(() => highlightMentions(text, mentionable), [text, mentionable]);
  useLayoutEffect(() => {
    setExpanded(false);
  }, [text]);
  useLayoutEffect(() => {
    const element = paragraph.current;
    if (!element) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 28;
      setOverflowing(element.scrollHeight > lineHeight * COLLAPSE_LINES + 1);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [segments]);
  return (
    <div className="max-w-[88%]">
      {/* Padding lives on the wrapper: a clamped element would show a partial extra line inside its own padding. */}
      <div className="max-w-full rounded-xl bg-secondary/65 px-4 py-2.5">
        <p
          ref={paragraph}
          data-conversation-search-text="user"
          id={id}
          className={cn(
            "whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]",
            !expanded && !revealForSearch && "line-clamp-5",
          )}
        >
          {segments.map((segment, index) =>
            segment.mention ? (
              <span
                key={index}
                className="rounded bg-primary/10 px-1 font-medium text-primary"
              >
                {segment.text}
              </span>
            ) : (
              segment.text
            ),
          )}
        </p>
      {overflowing && !revealForSearch ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1.5 min-h-7 rounded text-xs font-medium text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
      </div>
    </div>
  );
}
