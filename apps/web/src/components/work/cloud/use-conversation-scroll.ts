"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

interface Position { top: number; following: boolean }

/** Keep each transcript's position independent, restoring it before paint. */
export function useConversationScroll(id: string, contentVersion: unknown, streamText: string) {
  const messages = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const paused = useRef(false);
  const positions = useRef(new Map<string, Position>());
  const current = useRef<{ id: string; element: HTMLDivElement; contentVersion: unknown; streamText: string } | null>(null);
  const observed = useRef<HTMLElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const remember = useCallback(() => {
    const active = current.current;
    if (!active) return;
    positions.current.delete(active.id);
    positions.current.set(active.id, { top: active.element.scrollTop, following: following.current });
    if (positions.current.size > 100) positions.current.delete(positions.current.keys().next().value!);
  }, []);
  const onScroll = useCallback(() => {
    const element = messages.current;
    if (!element || element !== current.current?.element) return;
    if (paused.current) { following.current = false; remember(); return; }
    following.current = element.scrollHeight - element.clientHeight - element.scrollTop < 80;
    remember();
  }, [remember]);

  // Run on commits so returning from Settings, or finishing the initial load,
  // also restores a newly mounted scroll surface with the same conversation ID.
  useLayoutEffect(() => {
    const element = messages.current;
    const body = content.current;
    if (element) {
      const previous = current.current;
      const switched = previous?.id !== id || previous.element !== element;
      const changed = previous?.contentVersion !== contentVersion || previous?.streamText !== streamText;
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      if (switched) {
        const saved = positions.current.get(id);
        following.current = saved?.following ?? true;
        element.scrollTop = following.current ? maximum : Math.min(saved?.top ?? 0, maximum);
      } else if (changed && following.current && !paused.current) element.scrollTop = maximum;
      current.current = { id, element, contentVersion, streamText };
      remember();
    }
    if (observed.current !== body) {
      observer.current?.disconnect();
      observed.current = body;
      if (element && body && typeof ResizeObserver !== "undefined") {
        observer.current = new ResizeObserver(() => {
          if (messages.current !== element || !following.current || paused.current) return;
          element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
          remember();
        });
        // Content can grow after Markdown clamping, fonts, or tool details settle.
        observer.current.observe(body);
        observer.current.observe(element);
      }
    }
  });
  useLayoutEffect(() => () => {
    observer.current?.disconnect();
    observer.current = null;
    observed.current = null;
  }, []);
  return { messages, content, following, paused, onScroll, remember };
}
