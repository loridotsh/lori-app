import type { ReactNode } from "react";

// Remounts when the top-level section changes, so a destination fades in
// instead of swapping abruptly. `display: contents` adds no layout box, and the
// fade is opacity-only so fixed and full-height descendants are unaffected.
export default function Template({ children }: { children: ReactNode }) {
  return <div className="contents *:motion-safe:animate-page-in">{children}</div>;
}
