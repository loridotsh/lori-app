import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { captureScrollAnchor, findTextMatches, revealMatch, type TextMatch } from "./textMatches";

interface Options {
  scope: string;
  enabled: boolean;
  container: RefObject<HTMLDivElement | null>;
  viewport: RefObject<HTMLDivElement | null>;
  hasEarlier: boolean;
  historyKey: string;
  loadingEarlier: boolean;
  historyPaused?: boolean;
  loadEarlier: () => Promise<boolean>;
  onInspect: () => void;
}

/** One find session per visible conversation; history remains owned by its existing controller. */
export function useConversationFind(options: Options) {
  const latest = useRef(options); latest.current = options;
  const input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [scannedQuery, setScannedQuery] = useState("");
  const [result, setResult] = useState<{ matches: TextMatch[]; limited: boolean }>({ matches: [], limited: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [pageBusy, setPageBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const session = useRef(0), request = useRef<symbol | null>(null);
  const attempted = useRef<string | null>(null);
  const active = open && options.enabled;
  const searching = active && !!query.trim();
  const index = Math.max(0, result.matches.findIndex(match => match.key === selected));
  const current = result.matches[index];
  const needsReveal = useRef(false);
  const lastQuery = useRef("");
  const show = useCallback(() => {
    if (!latest.current.enabled) return;
    latest.current.onInspect();
    setOpen(true);
    requestAnimationFrame(() => { input.current?.focus({ preventScroll: true }); input.current?.select(); });
  }, []);
  const close = useCallback(() => {
    const restore = captureScrollAnchor(latest.current.viewport.current);
    ++session.current;
    setOpen(false); setQuery(""); setScannedQuery(""); setResult({ matches: [], limited: false }); setSelected(null);
    trigger.current?.focus({ preventScroll: true });
    requestAnimationFrame(() => { restore(); trigger.current?.focus({ preventScroll: true }); });
  }, []);
  useLayoutEffect(() => {
    ++session.current; request.current = null; attempted.current = null;
    setOpen(false); setQuery(""); setScannedQuery(""); setResult({ matches: [], limited: false }); setSelected(null);
    setHistoryError(false); setPageBusy(false);
  }, [options.scope, options.enabled]);
  useEffect(() => () => { ++session.current; request.current = null; }, []);
  useEffect(() => {
    if (!options.enabled) return;
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-conversation-find-ignore],dialog,[role="dialog"],[aria-modal="true"]') || document.querySelector('dialog[open],[aria-modal="true"]')) return;
      // A file editor or settings input keeps its own search shortcut.
      if (target?.closest('input,textarea,[contenteditable="true"]') && target !== input.current && !latest.current.viewport.current?.parentElement?.contains(target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      show();
    };
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, [options.enabled, show]);
  const changeQuery = useCallback((value: string) => {
    if (value === query) return;
    setQuery(value); setScannedQuery("");
    // Retain the currently revealed message while the new query is scanned.
    // Clearing results first would repeatedly collapse/expand long messages as the user types.
    if (!value.trim()) { setSelected(null); setResult({ matches: [], limited: false }); }
    setHistoryError(false); attempted.current = null; needsReveal.current = true;
    latest.current.onInspect();
  }, [query]);

  useEffect(() => {
    const container = options.container.current;
    if (!searching || !container) { setResult({ matches: [], limited: false }); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scan = () => {
      const next = findTextMatches(container, query);
      const changed = lastQuery.current !== query;
      lastQuery.current = query;
      setResult(next);
      setScannedQuery(query);
      setSelected(previous => !changed && next.matches.some(match => match.key === previous) ? previous : next.matches[0]?.key ?? null);
    };
    const schedule = () => { if (timer !== undefined) return; timer = setTimeout(() => { timer = undefined; scan(); }, 100); };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(container, { subtree: true, childList: true, characterData: true });
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [searching, query, options.scope, options.container]);

  useLayoutEffect(() => {
    if (!searching || !current || !needsReveal.current || !options.viewport.current) return;
    needsReveal.current = false;
    latest.current.onInspect();
    revealMatch(current, options.viewport.current);
  }, [current, searching, options.viewport]);
  const move = (direction: number) => {
    if (scannedQuery !== query || !result.matches.length) return;
    const next = result.matches[(index + direction + result.matches.length) % result.matches.length];
    if (!next) return;
    latest.current.onInspect();
    if (next.key === current?.key) {
      if (options.viewport.current) revealMatch(next, options.viewport.current);
    } else {
      needsReveal.current = true;
      setSelected(next.key);
    }
  };

  useEffect(() => {
    if (!searching || !options.hasEarlier || options.loadingEarlier || options.historyPaused || historyError || result.limited || request.current) return;
    if (attempted.current === options.historyKey) { setHistoryError(true); return; }
    const owner = session.current;
    const timer = setTimeout(() => {
      const token = Symbol(); request.current = token;
      attempted.current = latest.current.historyKey;
      setPageBusy(true);
      void latest.current.loadEarlier().then(loaded => {
        if (session.current === owner && !loaded) setHistoryError(true);
      }).catch(() => { if (session.current === owner) setHistoryError(true); }).finally(() => {
        if (request.current === token) { request.current = null; setPageBusy(false); }
      });
    }, 160);
    return () => clearTimeout(timer);
  }, [searching, query, options.hasEarlier, options.historyKey, options.loadingEarlier, options.historyPaused, historyError, result.limited, pageBusy, retry]);

  return {
    active, searching, scanning: searching && scannedQuery !== query, input, trigger, query, show, close, changeQuery, move,
    revealMessageId: searching ? current?.messageId : undefined,
    matches: searching && scannedQuery === query ? result.matches : [], current: searching && scannedQuery === query ? current : undefined,
    count: searching && scannedQuery === query ? result.matches.length : 0, position: current && searching && scannedQuery === query ? index + 1 : 0,
    limited: result.limited, incomplete: options.hasEarlier,
    historyError, loading: searching && options.hasEarlier && !historyError && !result.limited && !options.historyPaused,
    paused: searching && options.hasEarlier && options.historyPaused,
    retryHistory: () => { attempted.current = null; setHistoryError(false); setRetry(value => value + 1); },
  };
}
export type ConversationFind = ReturnType<typeof useConversationFind>;
