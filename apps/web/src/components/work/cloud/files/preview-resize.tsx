"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";

const DEFAULT_WIDTH = 520;
const MIN_WIDTH = 360;
const MAX_WIDTH = 880;
const STORAGE_KEY = "lori.cloud.preview.width.v1";
const clamp = (width: number, max: number) =>
  Math.round(Math.max(MIN_WIDTH, Math.min(max, width)));

/** Keep a readable conversation alongside the document, even when navigation resizes. */
export function usePreviewWidth(panel: RefObject<HTMLElement | null>) {
  const limit = () => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH,
    (panel.current?.parentElement?.clientWidth || window.innerWidth - 256) - 400));
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [maxWidth, setMaxWidth] = useState(MAX_WIDTH);
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(DEFAULT_WIDTH);
  const preferredWidth = useRef(DEFAULT_WIDTH);
  const gesture = useRef<{
    x: number;
    width: number;
    pointerId: number;
  } | null>(null);
  const restore = useRef<(() => void) | null>(null);
  const handle = useRef<HTMLDivElement>(null);

  const update = (next: number) => {
    widthRef.current = clamp(next, limit());
    setWidth(widthRef.current);
  };
  const save = () => {
    preferredWidth.current = widthRef.current;
    try {
      localStorage.setItem(STORAGE_KEY, String(widthRef.current));
    } catch {
      /* Storage can be disabled. */
    }
  };
  const finish = (cancel = false) => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    if (cancel) update(current.width);
    else save();
    if (handle.current?.hasPointerCapture(current.pointerId))
      handle.current.releasePointerCapture(current.pointerId);
    restore.current?.();
    restore.current = null;
    setDragging(false);
  };

  useLayoutEffect(() => {
    const max = limit();
    setMaxWidth(max);
    update(DEFAULT_WIDTH);
    try {
      const stored = Number(localStorage.getItem(STORAGE_KEY));
      if (Number.isFinite(stored) && stored > 0) {
        preferredWidth.current = clamp(stored, MAX_WIDTH);
        update(preferredWidth.current);
      }
    } catch {
      /* Use the default when storage is unavailable. */
    }
    const resize = () => {
      finish(true);
      setMaxWidth(limit());
      update(preferredWidth.current);
    };
    const blur = () => finish(true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    if (panel.current?.parentElement) observer?.observe(panel.current.parentElement);
    window.addEventListener("resize", resize);
    window.addEventListener("blur", blur);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", blur);
      restore.current?.();
    };
  }, []);

  return { width, maxWidth, dragging, handle, gesture, restore, widthRef, update, save, finish, setDragging };
}

export function PreviewResizeHandle({ width, maxWidth, dragging, handle, gesture, restore, widthRef, update, save, finish, setDragging }: ReturnType<typeof usePreviewWidth>) {
  return (
        <div
          ref={handle}
          role="separator"
          aria-label="Resize preview"
          aria-controls="cloud-file-preview"
          aria-orientation="vertical"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={maxWidth}
          aria-valuenow={width}
          aria-valuetext={`${width} pixels`}
          tabIndex={0}
          title="Drag to resize · Double-click to reset"
          className={cn(
            "group absolute inset-y-0 -left-1.5 z-30 w-3 touch-none cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:rounded-full after:transition-colors hover:after:bg-sidebar-ring/50 focus-visible:after:bg-sidebar-ring motion-reduce:after:transition-none",
            dragging && "after:bg-sidebar-ring/70",
          )}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            gesture.current = {
              x: event.clientX,
              width: widthRef.current,
              pointerId: event.pointerId,
            };
            const { cursor, userSelect } = document.body.style;
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            restore.current = () => {
              document.body.style.cursor = cursor;
              document.body.style.userSelect = userSelect;
            };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            if (gesture.current?.pointerId === event.pointerId)
              update(gesture.current.width - event.clientX + gesture.current.x);
          }}
          onPointerUp={() => finish()}
          onPointerCancel={() => finish(true)}
          onLostPointerCapture={() => finish(true)}
          onDoubleClick={() => {
            update(DEFAULT_WIDTH);
            save();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              finish(true);
              return;
            }
            const next =
              event.key === "ArrowLeft"
                ? width + (event.shiftKey ? 32 : 8)
                : event.key === "ArrowRight"
                  ? width - (event.shiftKey ? 32 : 8)
                  : event.key === "Home"
                    ? MIN_WIDTH
                    : event.key === "End"
                      ? maxWidth
                      : null;
            if (next === null) return;
            event.preventDefault();
            update(next);
            save();
          }}
        />
  );
}
