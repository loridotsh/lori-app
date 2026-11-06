"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * A waiting message that stays out of sight for the first moments. Most files open in well under
 * a quarter of a second, and a message that flashes for 30 ms reads as a glitch, not as help.
 * It is still announced to assistive technology from the start.
 */
export function QuietStatus({ children, after = 300 }: { children: ReactNode; after?: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), after);
    return () => clearTimeout(timer);
  }, [after]);
  return (
    <p role="status" className={visible ? "p-4 text-xs text-muted-foreground" : "sr-only"}>
      {children}
    </p>
  );
}
