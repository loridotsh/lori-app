import { useCallback, useEffect, useRef, useState } from "react";

/** Each copy control owns its feedback; a successful copy returns to rest. */
export function useCopyFeedback() {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++request.current;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  const copy = useCallback(async (text: string) => {
    const generation = ++request.current;
    if (timer.current !== null) clearTimeout(timer.current);
    setStatus("idle");
    try {
      await navigator.clipboard.writeText(text);
      if (!mounted.current || generation !== request.current) return;
      setStatus("copied");
      timer.current = setTimeout(() => {
        timer.current = null;
        setStatus("idle");
      }, 2000);
    } catch {
      if (mounted.current && generation === request.current) setStatus("failed");
    }
  }, []);
  return { status, copy };
}
